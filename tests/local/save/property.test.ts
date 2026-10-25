import fc from 'fast-check'
import assert from 'node:assert/strict'
import test from 'node:test'
import { hashKey } from '../../../src/local/db'
import { fromHex16, toHex } from '../../../src/local/hash'
import { toRecords } from '../../../src/local/records/records'
import {
    isChunkRowIntact,
    packHashes,
    unpackHashes,
    type ChunkRow,
} from '../../../src/local/records/rows'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import type { PendingRecords, SaveStore } from '../../../src/local/save/bodies'
import type { IdentityInput, SaveTarget } from '../../../src/local/save/build'
import { commitIdentity, IDENTITY_STORES, type IdentityUnit } from '../../../src/local/save/commit'
import { buildSave } from '../../../src/local/save/execute'
import { addRecords, headInput } from '../../../src/local/save/pending'
import { readSaveNeeds } from '../../../src/local/save/predicate'
import { sessionChecks } from '../../../src/local/testing/invariants'
import { nxspDiskState } from '../../../src/platform/fingerprint'
import { BGM, COVER, PREVIEW } from '../nxsp/helpers'
import {
    asFile,
    bindingOf,
    checkFiles,
    checkStack,
    commit,
    Fixture,
    hasUv,
    heldRows,
    saveOptions,
    SECOND,
    sourceOf,
    stateAt,
} from './fixture'

// The property-based Save test, as fast-check commands that
// shrink to the shortest failing script: edits, Saves of every kind (write-backs, downloads,
// Replace, Save As…, Recent Sessions' Save…), cleanup (thinning, and flags that leave a shared state's
// bodies: the cleanup case), session deletion, damage, a touched file, and storing paused and resumed
// (the binding in memory, `pending`). After each write:
// - no over-claim: the file holds every row with its state of each file its `completeFrom` names;
// - a write-back is an append of the file it replaced;
// - the line shows exactly when the write doesn't carry its base, and only for a loss or the stated
//   remainder (a flagged row whose state the base held through the stack, the head or its
//   own root): never a repeated line after nothing was lost;
// - the undo stack is replay's;
// - a self-pick loses no row of the picked file (damage storage knows of reads it first, and
//   so does damage the build before the picker finds, with a grant held), except, with no grant,
//   a row whose state needs a chunk gone bad that storage didn't know of: that row is written
//   `kept: false` and the line shows.
// Every file passes `tools/nxsp_check.py` at the end of each run. `npm test` runs a few; set
// NSE_SAVE_RUNS=<n> for more. Every run is seeded, and a failure prints the NSE_SAVE_SEED that
// reruns it and the NSE_SAVE_SCRIPT (JSON: the first state and the ops) that replays its shrunk
// script at once. (fast-check's own path replay can't walk a commands shrink it didn't run.)

type Row = { key: string; kept: boolean; snapshot: string }

type Written = {
    file: File
    id: string
    ancestors: string[]
    completeFrom: string
    /** Rows with their states, `kind|time|snapshot` → count. */
    rows: Map<string, number>
    /** Every row, held or not. */
    all: Map<string, number>
    list: Row[]
    roots: Set<string>
    /** The rows as values, for the append check. */
    entries: string[]
}

const facts = async (file: File): Promise<Written> => {
    const { rows, read, history } = await heldRows(file)
    const revision = read.project?.revision
    assert.ok(revision?.completeFrom)
    const all = new Map<string, number>()
    const list = history.entries.map((entry) => {
        const key = `${entry.kind}|${entry.time}|${entry.snapshot}`
        all.set(key, (all.get(key) ?? 0) + 1)
        return { key, kept: entry.kept !== false, snapshot: entry.snapshot }
    })
    return {
        file,
        id: revision.id,
        ancestors: revision.ancestors,
        completeFrom: revision.completeFrom,
        rows,
        all,
        list,
        roots: new Set(history.roots.keys()),
        entries: history.entries.map((entry) => JSON.stringify(entry)),
    }
}

const lacks = (n: Map<string, number>, b: Map<string, number>) =>
    [...b].some(([row, count]) => (n.get(row) ?? 0) < count)

/** Storage paused: every write fails, as with storing paused or full. */
const paused = (store: SaveStore): SaveStore => ({
    read: store.read,
    write: () => Promise.reject(new DOMException('Storing is paused', 'QuotaExceededError')),
})

type Op =
    | { t: 'edit'; k: number; second: boolean }
    | {
          t: 'undo' | 'redo' | 'continue' | 'save' | 'download' | 'saveAs' | 'replace' | 'touch'
      }
    /** `granted`: read access held, so a damaged build reads the file first without a prompt. */
    | { t: 'pick'; granted: boolean }
    | { t: 'pause' | 'resume' }
    | { t: 'saveToFile' | 'delete'; s: number }
    | { t: 'thin' | 'flag'; s: number; r: number }
    | { t: 'damage'; i: number }
    /** Another chain's build finds the bad chunks and records them in its `badChunks`. */
    | { t: 'known' }

const describe = (op: Op) => Object.values(op).join(' ')

class Scenario {
    readonly files: Written[] = []
    /** The bound file on "disk", when the binding has one. */
    disk: File | undefined
    /** The file the binding records: the base of the next write. */
    base: Written | undefined
    /** Storing paused: the last stored `seq` of the session, and the binding in memory. */
    pause: { stored: number; unit?: IdentityUnit; file?: IdentityInput['file'] } | undefined
    docs = 0
    /** Whether the last write showed a steps line ("were not kept" or "may not be included"). */
    line = false
    readonly log: string[] = []

    constructor(readonly fixture: Fixture) {}

    private identity(): IdentityInput | undefined {
        const unit = this.pause?.unit
        if (!unit) return
        return {
            docId: unit.docId,
            revision: unit.revision,
            ...(this.pause?.file ? { file: this.pause.file } : {}),
            marks: [...unit.marks],
        }
    }

    async write(target: SaveTarget, kind: 'saved' | 'downloaded' | 'none') {
        const { fixture } = this
        if (!this.pause) await fixture.flush()
        const savedId = target.kind === 'new' ? target.sessionId : undefined
        const session = savedId
            ? fixture.sessions.find((each) => each.id === savedId)
            : fixture.session
        assert.ok(session)
        const slot = session.slots[session.index]
        assert.ok(slot)
        const head = toHex(slot.snapshot)
        const current = session === fixture.session
        const identity = this.identity()
        const extra = {
            head: headInput(fixture.stateOf(head)),
            ...(this.pause && current ? { pending: fixture.pending(this.pause.stored) } : {}),
            ...(identity ? { identity } : {}),
        }
        const files = target.kind === 'append' && this.disk ? [await sourceOf(this.disk)] : []
        const store = this.pause ? paused(fixture.store) : fixture.store
        const build = async (more = {}) => {
            const { options, reserved } = saveOptions(fixture, { ...extra, ...more })
            const built = await buildSave(store, fixture.chainId, target, options, files)
            return { built, options, reserved }
        }
        let run = await build()
        if ('refused' in run.built && run.built.refused === 'unreadableHead' && !extra.pending) {
            // The page posts the live head's records when its stored copy fails (`runBuild`).
            const records: PendingRecords = { roots: {}, nodes: {}, chunks: {} }
            addRecords(records, fixture.stateOf(head))
            run = await build({ pending: { entries: [], records } })
        }
        const { built, options, reserved } = run
        assert.ok(!('refused' in built), JSON.stringify(built))
        const file = asFile(built.blob)
        const written = await facts(file)
        this.check(target, written, built.stepsLine !== 'none')
        await checkStack(file)
        this.files.push(written)
        this.line = built.stepsLine !== 'none'
        if (kind === 'none') return
        const disk =
            kind === 'saved' ? { ...(await nxspDiskState(file, file.lastModified)) } : undefined
        if (this.pause) {
            fixture.recordSave(built, reserved)
            const binding = bindingOf(built, reserved, options, {
                event: kind,
                ...(disk ? { disk } : {}),
            })
            this.pause.unit = {
                docId: built.identity.docId,
                revision: built.identity.revision,
                file: binding,
                marks: built.identity.marks,
            }
            this.pause.file = {
                ...(binding.entry ? { entry: binding.entry } : {}),
                ...(binding.completeFrom === undefined
                    ? {}
                    : { completeFrom: binding.completeFrom }),
                ...(disk ? { disk } : {}),
            }
        } else
            await commit(fixture, built, reserved, options, {
                event: kind,
                ...(disk ? { disk } : {}),
            })
        this.base = written
        this.disk = kind === 'saved' ? file : undefined
    }

    /** The stored chunks whose bytes fail their CRC, as hex. */
    private badChunks() {
        return this.fixture.store.read(['chunks'], async (tx) => {
            const bad = new Set<string>()
            for (const key of await tx.getAllKeys('chunks')) {
                if (!(key instanceof ArrayBuffer)) continue
                const row = (await tx.get('chunks', key)) as ChunkRow | undefined
                const hash = new Uint8Array(key)
                if (!row || !isChunkRowIntact(hash, row)) bad.add(toHex(hash))
            }
            return bad
        })
    }

    /** Every chain's `badChunks`: damage storage knows of, as hex. */
    private async knownBad() {
        const chains = await this.fixture.store.read(['chains'], (tx) => tx.getAll('chains'))
        const known = new Set<string>()
        for (const chain of chains as { badChunks?: unknown }[])
            if (chain.badChunks instanceof Uint8Array)
                for (const hash of unpackHashes(chain.badChunks)) known.add(toHex(hash))
        return known
    }

    /** The build a save picker's flow makes before the picker: a copy, marks and all. */
    private async probe() {
        const { fixture } = this
        await fixture.flush()
        const head = fixture.head
        const build = async (more = {}) => {
            const { options } = saveOptions(fixture, {
                head: headInput(fixture.stateOf(head)),
                ...more,
            })
            return buildSave(fixture.store, fixture.chainId, { kind: 'copy' }, options, [])
        }
        let built = await build()
        if ('refused' in built && built.refused === 'unreadableHead') {
            const records: PendingRecords = { roots: {}, nodes: {}, chunks: {} }
            addRecords(records, fixture.stateOf(head))
            built = await build({ pending: { entries: [], records } })
        }
        assert.ok(!('refused' in built), JSON.stringify(built))
        return built
    }

    /** The chunks a state's snapshot needs, as hex. */
    private chunksOf(snapshot: string) {
        const encoded = encodeSnapshot(toRecords(this.fixture.stateOf(snapshot)))
        return [encoded.header, ...encoded.chunks].map((chunk) => toHex(chunk.hash))
    }

    /** The oracle. */
    private check(target: SaveTarget, n: Written, line: boolean) {
        const script = this.log.join('\n')
        // A write-back is an append: the file it replaced is its first rows, as values.
        if (target.kind === 'append') {
            const old = this.files.find((each) => each.file === this.disk)
            assert.ok(old, script)
            assert.deepEqual(n.entries.slice(0, old.entries.length), old.entries, script)
            assert.equal(n.completeFrom, old.completeFrom, script)
            assert.equal(line, false, script)
        }
        // No over-claim: N holds every row with its state of each file from R to N.
        for (const f of this.files) {
            if (!n.ancestors.includes(f.id)) continue
            if (f.id !== n.completeFrom && !f.ancestors.includes(n.completeFrom)) continue
            for (const [row, count] of f.rows)
                assert.ok(
                    (n.rows.get(row) ?? 0) >= count,
                    `${n.id} claims ${f.id}'s row ${row}, which it lacks\n${script}`,
                )
        }
        const b = this.base
        if (target.kind === 'append' || !b) {
            assert.equal(line, false, script)
            return
        }
        // Not new: the line is exactly "not carried".
        if (target.kind !== 'new') assert.equal(line, n.completeFrom !== b.completeFrom, script)
        if (!line) return
        // A line shows only for a loss, or for the stated remainder.
        const lostRow = lacks(n.all, b.all) || lacks(n.rows, b.rows)
        const keptStates = new Set(
            n.list.filter((row) => row.kept && b.all.has(row.key)).map((row) => row.snapshot),
        )
        const remainder = n.list.some(
            (row) =>
                !row.kept &&
                b.all.has(row.key) &&
                b.roots.has(row.snapshot) &&
                !keptStates.has(row.snapshot),
        )
        assert.ok(
            lostRow || remainder,
            `${n.id} shows the line though it holds every row of ${b.id} with its state\n${script}`,
        )
    }

    async apply(op: Op) {
        const { fixture } = this
        this.log.push(describe(op))
        switch (op.t) {
            case 'edit':
                await fixture.edit(op.k + (op.second ? SECOND : 0))
                return
            case 'undo':
                fixture.undo()
                return
            case 'redo':
                fixture.redo()
                return
            case 'continue':
                if (this.pause) return
                await fixture.flush()
                await fixture.start()
                return
            case 'save':
                if (this.disk) await this.write({ kind: 'append', source: 'target' }, 'saved')
                else await this.write({ kind: 'copy' }, 'saved')
                return
            case 'download':
                await this.write({ kind: 'copy' }, 'downloaded')
                return
            case 'saveAs':
                await this.write({ kind: 'new', docId: `doc-${++this.docs}` }, 'saved')
                return
            case 'replace':
                // Replace keeps the file on disk first, so it fails while storing is paused.
                if (this.pause) return
                await this.write({ kind: 'replace', replaces: 'theirs' }, 'saved')
                return
            case 'saveToFile': {
                const session = fixture.sessions[op.s % fixture.sessions.length]
                assert.ok(session)
                await this.write(
                    { kind: 'new', docId: `doc-${++this.docs}`, sessionId: session.id },
                    'none',
                )
                return
            }
            case 'thin': {
                if (this.pause) return
                await fixture.flush()
                const s = op.s % fixture.sessions.length
                const rows = fixture.sessions[s]?.rows.length ?? 1
                await fixture.thin(s, op.r % Math.max(1, rows))
                return
            }
            case 'flag': {
                // Cleanup's flag alone: the row is stored `kept: false`, its bodies stay.
                if (this.pause) return
                await fixture.flush()
                const session = fixture.sessions[op.s % fixture.sessions.length]
                const row = session?.rows[op.r % Math.max(1, session.rows.length)]
                if (!row?.kept) return
                row.kept = false
                await fixture.store.write(['entries'], async (tx) => {
                    const stored = (await tx.get('entries', [row.sessionId, row.seq])) as
                        Record<string, unknown> | undefined
                    if (stored) await tx.put('entries', { ...stored, kept: false })
                })
                return
            }
            case 'delete':
                if (this.pause || fixture.sessions.length < 2) return
                await fixture.flush()
                await fixture.deleteSession(op.s % (fixture.sessions.length - 1))
                return
            case 'known': {
                // Bodies are shared between chains: another chain's build found this storage's
                // bad chunks, and marked only its own rows.
                const bad = await this.badChunks()
                if (!bad.size) return
                await fixture.store.write(['chains'], (tx) =>
                    tx.put('chains', {
                        chainId: 'another',
                        docId: 'another',
                        lineageId: 'another',
                        badChunks: packHashes([...bad].map(fromHex16)),
                    }),
                )
                return
            }
            case 'damage': {
                // A stored chunk's bytes go bad.
                if (!this.pause) await fixture.flush()
                const keys = await fixture.store.read(['chunks'], (tx) => tx.getAllKeys('chunks'))
                const key = keys[op.i % Math.max(1, keys.length)]
                if (!(key instanceof ArrayBuffer)) return
                await fixture.store.write(['chunks'], async (tx) => {
                    const row = (await tx.get('chunks', key)) as { bytes: Uint8Array }
                    const bytes = row.bytes.slice()
                    bytes[0] = (bytes[0] ?? 0) ^ 0x5a
                    await tx.put('chunks', { ...row, bytes }, hashKey(new Uint8Array(key)))
                })
                return
            }
            case 'touch': {
                // The same bytes with a new time: still at the base.
                if (this.pause || !this.disk) return
                const old = this.files.find((each) => each.file === this.disk)
                this.disk = new File([this.disk], this.disk.name, {
                    lastModified: this.disk.lastModified + 5000,
                })
                const chain = await fixture.chain()
                const disk = await nxspDiskState(this.disk, this.disk.lastModified)
                await fixture.putChain({ file: { ...(chain.file as object), disk: { ...disk } } })
                if (old) this.files.push({ ...old, file: this.disk })
                return
            }
            case 'pick': {
                // A save picker returns the chain's own file. The
                // dialog reads it first when storage may lack what it holds (`saveNeeds`: the
                // carry test, and damage storage knows of), asking for access if it must. The
                // build before the picker may still find damage; with a grant held the file is
                // read then, before the picker empties it.
                if (this.pause || !this.disk) return
                const old = this.files.find((each) => each.file === this.disk)
                if (!old) return
                const needs = await readSaveNeeds(fixture.store, fixture.chainId, [])
                const known = await this.knownBad()
                const bad = await this.badChunks()
                let read = !needs.carries || needs.lacking.length > 0
                if (!read) {
                    const probe = await this.probe()
                    read = op.granted && (probe.damaged.length > 0 || probe.marked > 0)
                }
                if (!read) this.disk = undefined
                await this.write(
                    read ? { kind: 'append', source: 'target' } : { kind: 'copy' },
                    'saved',
                )
                // No version is lost: the new file holds every row of the picked one, with its
                // state. Only unread, with no grant to read it after the build found damage, is a
                // row lost: one whose state needs a chunk gone bad that storage didn't know of. It
                // is written `kept: false`, and the write says so.
                const n = this.files.at(-1)
                assert.ok(n)
                const script = this.log.join('\n')
                for (const [row, count] of old.rows) {
                    if ((n.rows.get(row) ?? 0) >= count) continue
                    const snapshot = row.slice(row.lastIndexOf('|') + 1)
                    assert.ok(
                        !read &&
                            this.chunksOf(snapshot).some((hex) => bad.has(hex) && !known.has(hex)),
                        `a self-pick lost ${row}\n${script}`,
                    )
                    assert.ok(
                        (n.all.get(row) ?? 0) >= count,
                        `a self-pick dropped ${row}\n${script}`,
                    )
                    assert.equal(this.line, true, `a self-pick lost ${row} silently\n${script}`)
                }
                return
            }
            case 'pause':
                if (this.pause) return
                await fixture.flush()
                this.pause = { stored: fixture.session.rows.at(-1)?.seq ?? 0 }
                return
            case 'resume': {
                const pause = this.pause
                if (!pause) return
                this.pause = undefined
                // Storing resumes: the rows, then the binding with its marks, as one flush.
                await fixture.flush()
                if (pause.unit) {
                    const unit = pause.unit
                    const committed = await fixture.store.write(IDENTITY_STORES, (tx) =>
                        commitIdentity(tx, fixture.chainId, unit),
                    )
                    assert.equal(committed, true)
                }
                return
            }
        }
    }

    async end() {
        await this.apply({ t: 'resume' })
        await this.apply({ t: 'save' })
        if (hasUv) {
            const result = await checkFiles(this.files.map((each) => each.file))
            assert.equal(result.status, 0, `${result.output}\n${this.log.join('\n')}`)
        }
    }
}

type Model = { ops: number }

/** The stored rows hold the session invariants after every op. */
const checkRows = (scenario: Scenario, op: Op) =>
    assert.deepEqual(
        sessionChecks(scenario.fixture.world.memory, {
            maxSeenTime: false,
            hole: scenario.fixture.isHole,
        }),
        [],
        `session rows break an invariant after ${describe(op)}\n${scenario.log.join('\n')}`,
    )

class Command implements fc.AsyncCommand<Model, Scenario> {
    constructor(readonly op: Op) {}
    check = () => true
    async run(model: Model, real: Scenario) {
        model.ops++
        await real.apply(this.op)
        checkRows(real, this.op)
    }
    toString = () => describe(this.op)
}

const nat = (max: number) => fc.nat({ max })

const op: fc.Arbitrary<Op> = fc.oneof(
    {
        weight: 24,
        arbitrary: fc.record({ t: fc.constant('edit'), k: nat(11), second: fc.boolean() }),
    },
    { weight: 8, arbitrary: fc.constant({ t: 'undo' }) },
    { weight: 4, arbitrary: fc.constant({ t: 'redo' }) },
    { weight: 5, arbitrary: fc.constant({ t: 'continue' }) },
    { weight: 16, arbitrary: fc.constant({ t: 'save' }) },
    { weight: 12, arbitrary: fc.constant({ t: 'download' }) },
    { weight: 3, arbitrary: fc.constant({ t: 'saveAs' }) },
    { weight: 4, arbitrary: fc.constant({ t: 'replace' }) },
    { weight: 3, arbitrary: fc.record({ t: fc.constant('saveToFile'), s: nat(9) }) },
    { weight: 8, arbitrary: fc.record({ t: fc.constant('thin'), s: nat(9), r: nat(40) }) },
    { weight: 8, arbitrary: fc.record({ t: fc.constant('flag'), s: nat(9), r: nat(40) }) },
    { weight: 8, arbitrary: fc.record({ t: fc.constant('delete'), s: nat(9) }) },
    { weight: 4, arbitrary: fc.record({ t: fc.constant('damage'), i: nat(1000) }) },
    { weight: 2, arbitrary: fc.constant({ t: 'known' }) },
    { weight: 3, arbitrary: fc.constant({ t: 'touch' }) },
    { weight: 6, arbitrary: fc.record({ t: fc.constant('pick'), granted: fc.boolean() }) },
    { weight: 3, arbitrary: fc.constant({ t: 'pause' }) },
    { weight: 4, arbitrary: fc.constant({ t: 'resume' }) },
) as fc.Arbitrary<Op>

const runs = Number(process.env.NSE_SAVE_RUNS ?? 3)
// Always seeded, so a failure names the seed that reruns it, whoever ran it.
const seed = process.env.NSE_SAVE_SEED
    ? Number(process.env.NSE_SAVE_SEED)
    : (Date.now() ^ (Math.random() * 0x100000000)) | 0
const script = process.env.NSE_SAVE_SCRIPT

/** One script: the first state, then the commands in order. */
const runScript = async (start: number, ops: Iterable<Op>) => {
    const fixture = await Fixture.create()
    await fixture.storeMedia([BGM, COVER, PREVIEW])
    await fixture.start(start)
    const scenario = new Scenario(fixture)
    for (const each of ops) {
        await scenario.apply(each)
        checkRows(scenario, each)
    }
    await scenario.end()
    checkRows(scenario, { t: 'save' })
}

test('random edits and Saves never lose a version, over-claim or repeat the line', async () => {
    if (script) {
        const { start, ops } = JSON.parse(script) as { start: number; ops: Op[] }
        await runScript(start, ops)
        return
    }
    const details = await fc.check(
        fc.asyncProperty(
            nat(3),
            fc.commands([op.map((each) => new Command(each))], { maxCommands: 40, size: 'max' }),
            async (start, commands) => {
                const fixture = await Fixture.create()
                await fixture.storeMedia([BGM, COVER, PREVIEW])
                await fixture.start(start)
                const scenario = new Scenario(fixture)
                await fc.asyncModelRun(() => ({ model: { ops: 0 }, real: scenario }), commands)
                await scenario.end()
                checkRows(scenario, { t: 'save' })
            },
        ),
        { numRuns: runs, seed },
    )
    if (!details.failed) return
    // The shrunk script, as the commands that ran: fast-check's wrappers say which did.
    const [start, commands] = details.counterexample ?? []
    const ops = [...((commands ?? []) as unknown as Iterable<{ cmd: Command; hasRan: boolean }>)]
        .filter((each) => each.hasRan)
        .map((each) => each.cmd.op)
    const failure = new Error(
        [
            `Rerun with NSE_SAVE_SEED=${details.seed} NSE_SAVE_RUNS=${details.numRuns}, or replay`,
            `the shrunk script with NSE_SAVE_SCRIPT='${JSON.stringify({ start, ops })}'`,
            fc.defaultReportMessage(details) ?? '',
        ].join('\n'),
    )
    if (details.errorInstance) failure.cause = details.errorInstance
    throw failure
})

const cases = [
    { name: 'no build has found, without a grant held', granted: false, known: false },
    { name: 'no build has found, with a grant held', granted: true, known: false },
    { name: 'another chain’s build found, without a grant held', granted: false, known: true },
]

for (const { name, granted, known } of cases)
    test(`a self-pick after damage ${name}`, async () => {
        // The counterexample "edit, edit, save, edit, edit, damage, pick" (save-prop): the damaged
        // chunk is the one only `init`'s state needs, so the carry test (stored rows only) can't
        // see it and the dialog doesn't read the file. The build before the picker finds it
        //: with a grant held the file is read then and appended to, keeping `init`;
        // without one, the write from storage marks `init` and says so.
        const fixture = await Fixture.create()
        await fixture.storeMedia([BGM, COVER, PREVIEW])
        await fixture.start(1)
        const scenario = new Scenario(fixture)
        for (const k of [2, 3]) await scenario.apply({ t: 'edit', k, second: false })
        await scenario.apply({ t: 'save' })
        for (const k of [4, 5]) await scenario.apply({ t: 'edit', k, second: false })
        await fixture.flush()
        const chunks = (k: number) => {
            const encoded = encodeSnapshot(toRecords(stateAt(k).state))
            return [encoded.header, ...encoded.chunks].map((chunk) => toHex(chunk.hash))
        }
        const shared = new Set([2, 3, 4, 5].flatMap(chunks))
        const own = chunks(1).find((hex) => !shared.has(hex))
        const keys = await fixture.store.read(['chunks'], (tx) => tx.getAllKeys('chunks'))
        const i = keys.findIndex(
            (key) => key instanceof ArrayBuffer && toHex(new Uint8Array(key)) === own,
        )
        assert.ok(i >= 0)
        await scenario.apply({ t: 'damage', i })
        // Known damage reads the file first whatever the grant (the dialog asks for one).
        if (known) await scenario.apply({ t: 'known' })
        await scenario.apply({ t: 'pick', granted })
        assert.equal(scenario.line, !granted && !known)
        await scenario.end()
    })
