import assert from 'node:assert/strict'
import test from 'node:test'
import { BuildRefused, rootOf, runBuild, type BuildEnv } from '../../src/editor/save/build'
import { hashKey } from '../../src/local/db'
import type { Flusher, FlushSession, PendingEntry } from '../../src/local/flush'
import { fromHex16, toHex } from '../../src/local/hash'
import { toRecords } from '../../src/local/records/records'
import { encodeSnapshot } from '../../src/local/records/snapshot'
import { buildSave } from '../../src/local/save/execute'
import type { BuildSaveRequest } from '../../src/local/worker/saveHandlers'
import { editStep, futureFixtureOperation } from '../helpers/historySteps'
import { Fixture, heldRows, stateAt } from '../local/save/fixture'

// The head written from the live state: a build refused for a head storage
// can't read is made once more with the live head's records added to this tab's pending part,
// which keeps every record it had; Recent Sessions' Save… of a session that isn't open never retries.

const refusedHead = { refused: 'unreadableHead' as const }
const built = { saveEntry: { snapshot: '00'.repeat(16) } }

/** A worker whose first build refuses the head; resolves the builds' requests. */
const envWith = (entries: PendingEntry[]) => {
    const calls: BuildSaveRequest[] = []
    const session = {
        id: 'session',
        chainId: 'chain',
        docId: 'doc',
        lineageId: 'lineage',
        startedAt: 1,
        stored: true,
        chain: {},
    } as unknown as FlushSession
    const env: BuildEnv = {
        session,
        flusher: { unstored: () => ({ entries, stack: undefined }) } as unknown as Flusher,
        worker: {
            call: ((method: string, request: BuildSaveRequest) => {
                assert.equal(method, 'buildSave')
                calls.push(request)
                return Promise.resolve(calls.length === 1 ? refusedHead : built)
            }) as BuildEnv['worker']['call'],
        },
    }
    return { env, calls }
}

const request = (sessionId?: string) => ({
    target: { kind: 'copy' as const },
    history: true,
    bgm: true,
    fileName: 'coconut',
    save: { time: 1, operation: 'Saved' },
    state: stateAt(3).state,
    ...(sessionId === undefined ? {} : { sessionId }),
})

const edit = (seq: number, k: number): PendingEntry => ({
    kind: 'edit',
    step: editStep(futureFixtureOperation(`state-${k}`)),
    seq,
    wall: seq,
    state: stateAt(k).state,
    dirty: true,
})

test("a refused head is built again with the live head's records added to the unflushed ones", async () => {
    // One unflushed edit with its state, one undo onto a stored slot: its root only.
    const undo: PendingEntry = {
        kind: 'undo',
        step: editStep(futureFixtureOperation('state-1')),
        seq: 6,
        wall: 6,
        snapshot: fromHex16(stateAt(1).hex),
        dirty: true,
    }
    const { env, calls } = envWith([edit(5, 2), undo])
    assert.equal(await runBuild(env, request()), built)
    assert.equal(calls.length, 2)
    const [first, second] = calls.map((call) => call.options.pending!)
    assert.ok(first && second)
    // The rows as they were, and every record they had, with the head's own.
    assert.deepEqual(second.entries, first.entries)
    assert.equal(second.startedAt, first.startedAt)
    for (const kind of ['roots', 'nodes', 'chunks'] as const)
        for (const [key, value] of Object.entries(first.records[kind]))
            assert.deepEqual(second.records[kind][key], value, `${kind} ${key}`)
    assert.ok(first.records.roots[stateAt(2).hex])
    const head = rootOf(stateAt(3).state)
    assert.equal(first.records.roots[head], undefined)
    assert.ok(second.records.roots[head])
    // The rest of the request is the first's.
    assert.deepEqual(
        { ...calls[1]!, options: { ...calls[1]!.options, pending: undefined } },
        {
            ...calls[0]!,
            options: { ...calls[0]!.options, pending: undefined },
        },
    )
})

test("a refused head with nothing unflushed is built again from the live head's records alone", async () => {
    const { env, calls } = envWith([])
    assert.equal(await runBuild(env, request()), built)
    assert.equal(calls.length, 2)
    assert.equal(calls[0]!.options.pending, undefined)
    const pending = calls[1]!.options.pending!
    assert.deepEqual(pending.entries, [])
    assert.ok(pending.records.roots[rootOf(stateAt(3).state)])
})

test("Recent Sessions' Save… of a session that isn't open never builds again: the refusal stands", async () => {
    const { env, calls } = envWith([edit(5, 2)])
    await assert.rejects(
        runBuild(env, request('other')),
        (error) => error instanceof BuildRefused && error.refusal.refused === 'unreadableHead',
    )
    assert.equal(calls.length, 1)
    // It takes nothing of this tab's: no pending part, no live head.
    assert.equal(calls[0]!.options.pending, undefined)
    assert.equal(calls[0]!.options.head, undefined)
})

test('the writer takes the retry: an unflushed undo onto a stored head gone bad is written whole', async () => {
    // Stored: init 0, edit 1, edit 2. Unflushed: an undo onto 1, a stored slot (its root only). A
    // chunk only state 1 has goes bad, so the first build can't read the head.
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.edit(2)
    await fixture.flush()
    fixture.undo()
    const own = (k: number) => {
        const encoded = encodeSnapshot(toRecords(stateAt(k).state))
        return [encoded.header, ...encoded.chunks].map((chunk) => toHex(chunk.hash))
    }
    const shared = new Set([...own(0), ...own(2)])
    const hex = own(1).find((each) => !shared.has(each))
    assert.ok(hex)
    await fixture.store.write(['chunks'], async (tx) => {
        const key = hashKey(fromHex16(hex))
        const row = (await tx.get('chunks', key)) as { bytes: Uint8Array }
        const bytes = row.bytes.slice()
        bytes[0] = (bytes[0] ?? 0) ^ 0x5a
        await tx.put('chunks', { ...row, bytes }, key)
    })
    const session = fixture.session
    const undo: PendingEntry = {
        kind: 'undo',
        step: session.rows.at(-1)!.step!,
        seq: session.rows.at(-1)!.seq,
        wall: session.rows.at(-1)!.time,
        snapshot: fromHex16(stateAt(1).hex),
        dirty: false,
    }
    let builds = 0
    const env: BuildEnv = {
        session: {
            id: session.id,
            chainId: fixture.chainId,
            docId: fixture.docId,
            lineageId: 'lineage',
            startedAt: session.startedAt,
            stored: true,
            chain: {},
        } as unknown as FlushSession,
        flusher: {
            // The live stack as the flusher replays it: stored slots, by their roots.
            unstored: () => ({
                entries: [undo],
                stack: {
                    first: 0,
                    slots: session.slots.map((slot) => ({ hash: slot.snapshot, step: slot.step })),
                    index: session.index,
                },
            }),
        } as unknown as Flusher,
        worker: {
            call: ((method: string, { chainId, target, options, sources }: BuildSaveRequest) => {
                assert.equal(method, 'buildSave')
                builds++
                return buildSave(
                    fixture.store,
                    chainId,
                    target,
                    {
                        ...options,
                        context: { ...options.context, newId: () => crypto.randomUUID() },
                    },
                    sources,
                )
            }) as BuildEnv['worker']['call'],
        },
    }
    const result = await runBuild(env, { ...request(), state: stateAt(1).state })
    assert.equal(builds, 2)
    assert.equal(result.saveEntry.snapshot, stateAt(1).hex)
    // The head is in the file whole; the stored rows and the unflushed undo are there too.
    const { history } = await heldRows(result.blob)
    assert.deepEqual(
        history.entries.map((entry) => entry.kind),
        ['init', 'edit', 'edit', 'undo', 'save'],
    )
})
