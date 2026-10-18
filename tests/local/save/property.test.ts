import fc from 'fast-check'
import assert from 'node:assert/strict'
import test from 'node:test'
import { hashKey } from '../../../src/local/db'
import { toHex } from '../../../src/local/hash'
import type { PendingRecords, SaveStore } from '../../../src/local/save/bodies'
import type { IdentityInput, SaveTarget } from '../../../src/local/save/build'
import { commitIdentity, IDENTITY_STORES, type IdentityUnit } from '../../../src/local/save/commit'
import { buildSave } from '../../../src/local/save/execute'
import { addRecords, headInput } from '../../../src/local/save/pending'
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
} from './fixture'

// The property-based Save test (Part 1 §1.11.6; r12-arch-core M6), as fast-check commands that
// shrink to the shortest failing script: edits, Saves of every kind (write-backs, downloads,
// Replace, Save As…, Save to File…), cleanup (thinning, and flags that leave a shared state's
// bodies: the M7 case), session deletion, damage, a touched file, and storing paused and resumed
// (the binding in memory, `pending`). After each write:
// - no over-claim: the file holds every row with its state of each file its `completeFrom` names;
// - a write-back is an append of the file it replaced;
// - the line shows exactly when the write doesn't carry its base, and only for a loss or D25's
//   stated remainder (a flagged row whose state the base held through the stack, the head or its
//   own root): never a repeated line after nothing was lost;
// - the undo stack is replay's.
// Every file passes `tools/nxsp_check.py` at the end of each run. `npm test` runs a few; set
// NSE_SAVE_RUNS=<n> for more, and NSE_SAVE_SEED=<s> (with NSE_SAVE_PATH=<p>) to replay one.

type Row = { key: string; kept: boolean; snapshot: string }

type Written = {
    file: File
    id: string
    ancestors: string[]
    completeFrom: string
    /** Rows with their states (§1.6.11.6's oracle), `kind|time|snapshot` → count. */
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
    | { t: 'undo' | 'redo' | 'continue' | 'save' | 'download' | 'saveAs' | 'replace' | 'touch' }
    | { t: 'pause' | 'resume' }
    | { t: 'saveToFile' | 'delete'; s: number }
    | { t: 'thin' | 'flag'; s: number; r: number }
    | { t: 'damage'; i: number }

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
            // The page posts the live head's records when its stored copy fails (§1.6.11.6).
            const records: PendingRecords = { roots: {}, nodes: {}, chunks: {} }
            addRecords(records, fixture.stateOf(head))
            run = await build({ pending: { entries: [], records } })
        }
        const { built, options, reserved } = run
        assert.ok(!('refused' in built), JSON.stringify(built))
        const file = asFile(built.blob)
        const written = await facts(file)
        this.check(target, written, built.someStepsNotKept)
        await checkStack(file)
        this.files.push(written)
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

    /** The oracle (§1.6.11.6, D25). */
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
        // A line shows only for a loss, or for D25's stated remainder.
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
                // Cleanup's flag alone: the row is stored `kept: false`, its bodies stay (M7).
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

class Command implements fc.AsyncCommand<Model, Scenario> {
    constructor(readonly op: Op) {}
    check = () => true
    async run(model: Model, real: Scenario) {
        model.ops++
        await real.apply(this.op)
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
    { weight: 3, arbitrary: fc.constant({ t: 'touch' }) },
    { weight: 3, arbitrary: fc.constant({ t: 'pause' }) },
    { weight: 4, arbitrary: fc.constant({ t: 'resume' }) },
) as fc.Arbitrary<Op>

const runs = Number(process.env.NSE_SAVE_RUNS ?? 3)
const seed = process.env.NSE_SAVE_SEED
const path = process.env.NSE_SAVE_PATH

test('random edits and Saves never lose a version, over-claim or repeat the line', async () => {
    await fc.assert(
        fc.asyncProperty(
            nat(3),
            fc.commands([op.map((each) => new Command(each))], {
                maxCommands: 40,
                size: 'max',
                ...(path ? { replayPath: path } : {}),
            }),
            async (start, commands) => {
                const fixture = await Fixture.create()
                await fixture.storeMedia([BGM, COVER, PREVIEW])
                await fixture.start(start)
                const scenario = new Scenario(fixture)
                await fc.asyncModelRun(() => ({ model: { ops: 0 }, real: scenario }), commands)
                await scenario.end()
            },
        ),
        {
            numRuns: seed ? 1 : runs,
            ...(seed ? { seed: Number(seed) } : {}),
            ...(path ? { path } : {}),
        },
    )
})
