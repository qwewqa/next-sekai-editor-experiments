import assert from 'node:assert/strict'
import test from 'node:test'
import { hashKey } from '../../../src/local/db'
import { toHex } from '../../../src/local/hash'
import type { PendingRecords } from '../../../src/local/save/bodies'
import type { SaveTarget } from '../../../src/local/save/build'
import { addRecords, headInput } from '../../../src/local/save/pending'
import { nxspDiskState } from '../../../src/platform/fingerprint'
import { BGM, COVER, PREVIEW } from '../nxsp/helpers'
import { checkFiles, Fixture, hasUv, heldRows, save, SECOND, sourceOf, stateAt } from './fixture'
import { random, type Random } from './random'

// The property-based Save test (Part 1 §1.11.6; r12-arch-core M6): random edit scripts, random
// Save sequences (write-backs, downloads, Replace, Save As…, Save to File…) and random storage
// thinning, damage and session deletion over the in-memory store. After each Save, the multiset
// of held rows checks the written `completeFrom` (an under-claim is allowed: §1.6.11.6's
// safe-side gap), every write-back is an append of the file it replaced, and at the end every
// file passes `tools/nxsp_check.py`. Seeded and replayable: a failure names its seed and script.
// `npm test` runs a few seeds; NSE_SAVE_RUNS=<n> runs more, NSE_SAVE_SEED=<s> replays one.
// (fast-check, Step 6's dev dependency, isn't installed yet: `./random.ts` stands in.)

type Written = {
    file: File
    id: string
    ancestors: string[]
    completeFrom: string
    rows: Map<string, number>
    /** The rows of this file, in order, for the append check. */
    entries: string[]
}

const stateOfHex = (hex: string) => {
    for (let k = 0; k < 24; k++)
        for (const n of [k, SECOND + k]) if (stateAt(n).hex === hex) return stateAt(n).state
    throw new Error(`No state ${hex}`)
}

const facts = async (file: File): Promise<Written> => {
    const { rows, read, history } = await heldRows(file)
    const revision = read.project?.revision
    assert.ok(revision?.completeFrom)
    return {
        file,
        id: revision.id,
        ancestors: revision.ancestors,
        completeFrom: revision.completeFrom,
        rows,
        entries: history.entries.map((entry) => JSON.stringify(entry)),
    }
}

/** `completeFrom` never over-claims: N holds every row of each file from R to N that it names. */
const checkClaim = (n: Written, files: readonly Written[], script: string[]) => {
    for (const f of files) {
        if (f === n || !n.ancestors.includes(f.id)) continue
        if (f.id !== n.completeFrom && !f.ancestors.includes(n.completeFrom)) continue
        for (const [row, count] of f.rows)
            assert.ok(
                (n.rows.get(row) ?? 0) >= count,
                `${n.id} claims ${f.id}'s row ${row}, which it lacks\n${script.join('\n')}`,
            )
    }
}

const runs = Number(process.env.NSE_SAVE_RUNS ?? 4)
const only = process.env.NSE_SAVE_SEED

const scenario = async (seed: number) => {
    const rng: Random = random(seed)
    const fixture = await Fixture.create(seed)
    await fixture.storeMedia([BGM, COVER, PREVIEW])
    await fixture.start(rng.int(4))
    const script: string[] = [`seed ${seed}`]
    const files: Written[] = []
    /** The bound file at the base, when the binding has one on "disk". */
    let disk: File | undefined
    let docs = 0

    const diskOf = (file: File) =>
        nxspDiskState(file, file.lastModified).then((state) => ({ ...state }))

    const write = async (
        target: SaveTarget,
        label: string,
        kind: 'saved' | 'downloaded' | 'none',
    ) => {
        script.push(label)
        await fixture.flush()
        const saved = target.kind === 'new' && target.sessionId
        const session = saved ? fixture.sessions.find((each) => each.id === saved) : fixture.session
        assert.ok(session)
        const slot = session.slots[session.index]
        assert.ok(slot)
        const head = toHex(slot.snapshot)
        const extra = { head: headInput(stateOfHex(head)) }
        const files_ = target.kind === 'append' && disk ? [await sourceOf(disk)] : []
        const run = (more = {}) =>
            save(fixture, target, {
                files: files_,
                binds: kind !== 'none',
                event: kind === 'downloaded' ? 'downloaded' : 'saved',
                extra: { ...extra, ...more },
                ...(kind === 'saved' ? { disk: diskOf } : {}),
            })
        let result = await run()
        if ('refused' in result.built && result.built.refused === 'unreadableHead') {
            // The page posts the live head's records when its stored copy fails (§1.6.11.6).
            const records: PendingRecords = { roots: {}, nodes: {}, chunks: {} }
            addRecords(records, stateOfHex(head))
            result = await run({ pending: { entries: [], records } })
        }
        const { built, file } = result
        assert.ok(!('refused' in built), `${JSON.stringify(built)}\n${script.join('\n')}`)
        assert.ok(file)
        const written = await facts(file)
        // Every write-back is an append: the file it replaced is its first rows, as values.
        if (target.kind === 'append') {
            const old = files.find((each) => each.file === disk)
            assert.ok(old)
            assert.deepEqual(
                written.entries.slice(0, old.entries.length),
                old.entries,
                script.join('\n'),
            )
            assert.equal(written.completeFrom, old.completeFrom)
        }
        checkClaim(written, files, script)
        files.push(written)
        if (kind === 'saved') disk = file
        else if (kind === 'downloaded') disk = undefined
    }

    const steps = 18 + rng.int(18)
    for (let step = 0; step < steps; step++) {
        const roll = rng.int(100)
        if (roll < 34) {
            const k = rng.int(12) + (rng.int(5) === 0 ? SECOND : 0)
            script.push(`edit ${k}`)
            await fixture.edit(k)
        } else if (roll < 42) {
            script.push('undo')
            fixture.undo()
        } else if (roll < 46) {
            script.push('redo')
            fixture.redo()
        } else if (roll < 51) {
            script.push('continue')
            await fixture.flush()
            await fixture.start()
        } else if (roll < 61) {
            if (disk) await write({ kind: 'append', source: 'target' }, 'write-back', 'saved')
            else await write({ kind: 'copy' }, 'first save', 'saved')
        } else if (roll < 68) await write({ kind: 'copy' }, 'download', 'downloaded')
        else if (roll < 71)
            await write({ kind: 'new', docId: `doc-${seed}-${++docs}` }, 'save as', 'saved')
        else if (roll < 74) await write({ kind: 'replace', replaces: 'theirs' }, 'replace', 'saved')
        else if (roll < 77) {
            const session = fixture.sessions[rng.int(fixture.sessions.length)]
            assert.ok(session)
            await write(
                { kind: 'new', docId: `doc-${seed}-${++docs}`, sessionId: session.id },
                `save to file ${session.id}`,
                'none',
            )
        } else if (roll < 87) {
            const s = rng.int(fixture.sessions.length)
            const r = rng.int(fixture.sessions[s]?.rows.length ?? 1)
            await fixture.flush()
            if (await fixture.thin(s, r)) script.push(`thin ${s}:${r}`)
        } else if (roll < 92 && fixture.sessions.length > 1) {
            const s = rng.int(fixture.sessions.length - 1)
            script.push(`delete session ${s}`)
            await fixture.flush()
            await fixture.deleteSession(s)
        } else if (roll < 96) {
            // Damage in storage: a stored chunk's bytes go bad.
            await fixture.flush()
            const keys = await fixture.store.read(['chunks'], (tx) => tx.getAllKeys('chunks'))
            const key = keys[rng.int(keys.length)]
            if (key instanceof ArrayBuffer) {
                script.push(`damage ${toHex(new Uint8Array(key))}`)
                await fixture.store.write(['chunks'], async (tx) => {
                    const row = (await tx.get('chunks', key)) as { bytes: Uint8Array }
                    const bytes = row.bytes.slice()
                    bytes[0] = (bytes[0] ?? 0) ^ 0x5a
                    await tx.put('chunks', { ...row, bytes }, hashKey(new Uint8Array(key)))
                })
            }
        } else if (disk) {
            // The same bytes touched with a new time: still at the base.
            script.push('touch')
            const old = files.find((each) => each.file === disk)
            disk = new File([disk], disk.name, { lastModified: disk.lastModified + 5000 })
            const chain = await fixture.chain()
            const file = chain.file as Record<string, unknown>
            await fixture.putChain({ file: { ...file, disk: await diskOf(disk) } })
            if (old) files.push({ ...old, file: disk })
        }
    }
    await write(
        disk ? { kind: 'append', source: 'target' } : { kind: 'copy' },
        'last save',
        'saved',
    )
    if (hasUv) {
        const result = await checkFiles(files.map((each) => each.file))
        assert.equal(result.status, 0, `${result.output}\n${script.join('\n')}`)
    }
}

for (const seed of only ? [Number(only)] : Array.from({ length: runs }, (_, i) => i + 1))
    test(`random edits and Saves never lose a version or over-claim (seed ${seed})`, async () => {
        await scenario(seed)
    })
