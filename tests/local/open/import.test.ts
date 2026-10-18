import assert from 'node:assert/strict'
import test from 'node:test'
import { DB_NAME, hashKey } from '../../../src/local/db'
import { fromHex16, toHex } from '../../../src/local/hash'
import { keyText } from '../../../src/local/kv/keys'
import { executePlan, planNxsp, readNxsp, type ReadHistory } from '../../../src/local/nxsp'
import type { OpenStoreRequest } from '../../../src/local/open/importWrite'
import type { OpenReadReply } from '../../../src/local/open/opened'
import { carries, type ChainRow } from '../../../src/local/save/model'
import { stateBatch } from '../../../src/local/stateBatch'
import { createWorld, type World } from '../../../src/local/testing/world'
import {
    replay,
    stackMismatches,
    storedSlots,
    type ReplayEntry,
    type StackBlockRow,
} from '../../../src/local/timeline'
import type { WorkerContext } from '../../../src/local/worker/handlers'
import { openHandlers } from '../../../src/local/worker/openHandlers'
import { peekHandlers } from '../../../src/local/worker/peekHandlers'
import { openPage, rows, storedRecords } from '../flush/harness'
import { fresh } from '../nxsp/chain'
import { crafted, jsonOf, setJson } from '../nxsp/craft'
import { chartWith, headInput as headInputOf, levelOf } from '../nxsp/helpers'
import { stateOf } from '../records/charts'
import { damagedFile } from './files'

// The open's first transaction and its background import (Part 1 §1.5.4): the head stored at
// once with the stack and media, the file's rows, roots, nodes and chunks in batches, damage
// found by the import unlinking the chain (§1.6.11.8), an import that can't go on marking the
// rows whose states never arrived, and peeks of states not imported yet read from the file.

const setup = async (seed = 1) => {
    const world = createWorld({ seed })
    const page = await openPage(world, world.tab('a'))
    const context: WorkerContext = { core: page.core, test: true, emit: () => undefined }
    const open = openHandlers(context, page.tab.waiter)
    const peek = peekHandlers(context)
    return { world, page, open, peek, run: <T>(fn: () => Promise<T>) => page.tab.run(fn) }
}

const freshFile = async () => {
    const chain = fresh()
    return { ...chain, file: await executePlan(planNxsp(chain.input).plan, new Map()) }
}

const ids = { chainId: 'chain-1', sessionId: 'session-1', docId: 'doc', lineageId: 'lineage' }

const storeRequest = (id: string, extra: Partial<OpenStoreRequest> = {}): OpenStoreRequest => ({
    id,
    ids,
    chain: {
        name: 'Coconut (Master)',
        file: { name: 'coconut.nxsp', event: 'opened', options: { history: true, bgm: true } },
    },
    labels: { opened: 'Opened coconut.nxsp', changedOutside: 'Changed outside the editor' },
    wall: 2_000_000,
    appVersion: '0.6.0',
    ...extra,
})

const nxsp = (reply: OpenReadReply) => {
    assert.equal(reply.kind, 'nxsp')
    if (reply.kind !== 'nxsp') throw new Error('not nxsp')
    return reply
}

const historyOf = async (file: Blob): Promise<ReadHistory> => {
    const read = await readNxsp(file)
    if (read.kind !== 'nxsp' || !read.history) throw new Error('no history')
    return read.history
}

const sessionEntries = (world: World, sessionId = ids.sessionId) =>
    [...rows(world, 'entries').values()]
        .filter((row) => row.sessionId === sessionId)
        .sort((a, b) => (a.seq as number) - (b.seq as number))

const sessionRow = (world: World) => rows(world, 'sessions').get(ids.sessionId)
const chainRow = (world: World) => rows(world, 'chains').get(ids.chainId)

const hasNode = (world: World, hex: string) =>
    rows(world, 'nodes').has(keyText(hashKey(fromHex16(hex))))
const hasChunk = (world: World, hex: string) =>
    rows(world, 'chunks').has(keyText(hashKey(fromHex16(hex))))

const runAll = async (
    s: Awaited<ReturnType<typeof setup>>,
    id: string,
    batches: number,
    from = 0,
) => {
    const outcomes = []
    for (let n = from; n < batches; n++)
        outcomes.push(await s.run(() => s.open.openBatch({ id, n })))
    return outcomes
}

const storedStack = (world: World) => {
    const session = sessionRow(world)
    const window = session?.stack as { base: number; length: number; index: number }
    const blocks = [...rows(world, 'stackBlocks').values()].filter(
        (row) => row.sessionId === ids.sessionId,
    ) as unknown as StackBlockRow[]
    return {
        window,
        slots: storedSlots(window, (block) => blocks.find((row) => row.block === block)),
    }
}

test('an open stores its head at once, then imports every row, root, node and chunk', async () => {
    const s = await setup()
    const { file, hashes } = await freshFile()
    const reply = nxsp(await s.run(() => s.open.openRead(file)))
    assert.equal(reply.open, 'full')
    assert.equal(reply.history?.entries, 4)
    const stored = await s.run(() => s.open.openStore(storeRequest(reply.id)))
    assert.equal(stored.kind, 'stored')
    if (stored.kind !== 'stored') return
    const history = await historyOf(file)

    // The first transaction: the head whole, the stack's roots, the continue entry, the binding.
    assert.equal(toHex(stored.head), history.head)
    assert.ok(storedRecords(s.world, stored.head))
    for (const slot of history.undoStack.slots) assert.ok(hasNode(s.world, slot.snapshot))
    // A short history's rows come in the first transaction too.
    assert.deepEqual(
        sessionEntries(s.world).map((row) => [row.seq, row.kind]),
        [
            [1, 'init'],
            [2, 'edit'],
            [3, 'edit'],
            [4, 'save'],
            [5, 'continue'],
        ],
    )
    assert.equal(sessionRow(s.world)?.importPending, true)
    assert.equal(sessionRow(s.world)?.origin, 'nxsp')
    const binding = chainRow(s.world)?.file as Record<string, unknown>
    assert.equal(toHex(binding.hash as Uint8Array), history.head)
    assert.deepEqual(binding.entry, {
        sessionId: ids.sessionId,
        seq: 4,
        startedAt: sessionRow(s.world)?.startedAt,
        count: 4,
        notKept: 0,
    })
    assert.equal(chainRow(s.world)?.edited, undefined)
    assert.equal(chainRow(s.world)?.hasContent, true)
    // The media the file holds: the BGM and cover with bytes, the preview as metadata only.
    assert.equal(rows(s.world, 'media').size, 2)

    const outcomes = await runAll(s, reply.id, stored.batches)
    assert.ok(outcomes.every((outcome) => outcome.kind === 'done'))
    assert.equal(sessionRow(s.world)?.importPending, undefined)
    const entries = sessionEntries(s.world)
    assert.deepEqual(
        entries.map((row) => [row.seq, row.kind]),
        [
            [1, 'init'],
            [2, 'edit'],
            [3, 'edit'],
            [4, 'save'],
            [5, 'continue'],
        ],
    )
    assert.equal(sessionRow(s.world)?.entryCount, 5)
    // Imported rows keep their times, and the save row its revision and device.
    assert.equal(entries[0]?.time, 1000)
    assert.equal(entries[3]?.revisionId, 'r001-0000-4000-8000-000000000000')
    for (const hex of hashes) assert.ok(storedRecords(s.world, fromHex16(hex)))
    // Replay of the stored rows gives the stored stack (§1.3.9).
    const replayed = replay(entries as unknown as ReplayEntry[])
    assert.deepEqual(stackMismatches(storedStack(s.world), replayed), [])
})

test('a reopened file stores no chunk twice and imports nothing it already holds', async () => {
    const s = await setup(2)
    const { file } = await freshFile()
    const first = nxsp(await s.run(() => s.open.openRead(file)))
    const one = await s.run(() => s.open.openStore(storeRequest(first.id)))
    if (one.kind !== 'stored') throw new Error('not stored')
    await runAll(s, first.id, one.batches)
    const chunks = rows(s.world, 'chunks').size
    const second = nxsp(await s.run(() => s.open.openRead(file)))
    const two = await s.run(() =>
        s.open.openStore(
            storeRequest(second.id, {
                ids: { ...ids, chainId: 'chain-2', sessionId: 'session-2' },
            }),
        ),
    )
    if (two.kind !== 'stored') throw new Error('not stored')
    const outcomes = await runAll(s, second.id, two.batches)
    assert.ok(outcomes.every((outcome) => outcome.kind === 'done'))
    assert.equal(rows(s.world, 'chunks').size, chunks)
    assert.equal(sessionEntries(s.world, 'session-2').length, 5)
})

test('a peek of a state not imported yet reads it from the opened file', async () => {
    const s = await setup(3)
    const { file, hashes } = await freshFile()
    const reply = nxsp(await s.run(() => s.open.openRead(file)))
    await s.run(() => s.open.openStore(storeRequest(reply.id)))
    // The first state's chunks aren't stored yet; its root is (a stack slot).
    const first = hashes[0]!
    const read = await s.run(() => s.peek.readSnapshotVerified(first))
    assert.equal(read.kind, 'found')
})

test('a chunk failing its hash in the import is damage: the chain unlinks and its rows are damaged', async () => {
    const s = await setup(4)
    const { file, bad, hashes } = await damagedFile()
    const reply = nxsp(await s.run(() => s.open.openRead(file)))
    // Only the head's chunks and the headers are checked at open: it opens fully.
    assert.equal(reply.open, 'full')
    const stored = await s.run(() => s.open.openStore(storeRequest(reply.id)))
    if (stored.kind !== 'stored') throw new Error('not stored')
    const outcomes = await runAll(s, reply.id, stored.batches)
    const damaged = outcomes.find((outcome) => outcome.kind === 'damaged')
    assert.deepEqual(damaged, { kind: 'damaged', hashes: [bad] })
    // The import goes on: the rest arrives, and only the bad chunk is missing.
    assert.equal(sessionRow(s.world)?.importPending, undefined)
    assert.ok(!hasChunk(s.world, bad))

    const record = await s.run(() =>
        s.open.openUnlink({
            id: reply.id,
            chainId: ids.chainId,
            docId: 'doc-2',
            hashes: [bad],
            appVersion: '0.6.0',
        }),
    )
    assert.equal(record?.docId, 'doc-2')
    const chain = chainRow(s.world)!
    assert.equal(chain.docId, 'doc-2')
    assert.equal(chain.file, undefined)
    assert.equal(chain.revision, undefined)
    assert.equal(chain.lineageId, 'lineage')
    assert.deepEqual(chain.badChunks, fromHex16(bad))
    const entries = sessionEntries(s.world)
    // The first state's row is damaged; the others are whole.
    assert.deepEqual(
        entries.map((row) => [toHex(row.snapshot as Uint8Array) === hashes[0], row.kept]),
        [
            [true, false],
            [false, true],
            [false, true],
            [false, true],
            [false, true],
        ],
    )
})

test('an import that can’t go on marks the rows whose states never arrived kept: false', async () => {
    const s = await setup(5)
    const { file, hashes } = await freshFile()
    const reply = nxsp(await s.run(() => s.open.openRead(file)))
    const stored = await s.run(() => s.open.openStore(storeRequest(reply.id)))
    if (stored.kind !== 'stored') throw new Error('not stored')
    // The tab ends before any batch.
    assert.equal(await s.run(() => s.open.openAbandon(ids.sessionId)), true)
    assert.equal(sessionRow(s.world)?.importPending, undefined)
    const head = hashes[2]!
    assert.deepEqual(
        sessionEntries(s.world).map((row) => [row.seq, row.kept]),
        [
            [1, false],
            [2, false],
            [3, true],
            [4, true],
            [5, true],
        ],
    )
    assert.equal(toHex(sessionEntries(s.world)[2]!.snapshot as Uint8Array), head)
    // A batch after it finds the import ended.
    const late = await s.run(() => s.open.openBatch({ id: reply.id, n: 1 }))
    assert.equal(late.kind, 'notOpened')
})

test('a resumed import reads the file again and finishes it', async () => {
    const s = await setup(6)
    const { file, hashes } = await freshFile()
    const reply = nxsp(await s.run(() => s.open.openRead(file)))
    const stored = await s.run(() => s.open.openStore(storeRequest(reply.id)))
    if (stored.kind !== 'stored') throw new Error('not stored')
    await s.run(() => s.open.openBatch({ id: reply.id, n: 0 }))
    // The tab ended: its worker's opened files are gone.
    await s.run(() => Promise.resolve(s.open.openDrop(reply.id)))
    const changed = await s.run(() =>
        s.open.openResume({
            sessionId: ids.sessionId,
            file,
            revisionId: reply.project?.revision?.id,
            fingerprint: 'zip:other',
        }),
    )
    assert.deepEqual(changed, { kind: 'changed' })
    const resumed = await s.run(() =>
        s.open.openResume({
            sessionId: ids.sessionId,
            file,
            revisionId: reply.project?.revision?.id,
            fingerprint: reply.disk?.fingerprint,
        }),
    )
    assert.equal(resumed.kind, 'resumed')
    if (resumed.kind !== 'resumed') return
    const outcomes = await runAll(s, resumed.id, resumed.batches)
    assert.ok(outcomes.every((outcome) => outcome.kind === 'done'))
    assert.equal(sessionRow(s.world)?.importPending, undefined)
    assert.equal(sessionEntries(s.world).length, 5)
    for (const hex of hashes) assert.ok(storedRecords(s.world, fromHex16(hex)))
})

test('a file whose level differs from its history’s head gets "Changed outside the editor"', async () => {
    const s = await setup(7)
    const { file, hashes } = await freshFile()
    const edited = stateOf(chartWith({ extraNotes: 3 }))
    const changed = await crafted((items) => {
        setJson(items, 'level.json', levelOf(edited).level)
        const project = jsonOf(items, 'project.json')
        setJson(items, 'project.json', project)
    }, file)
    const reply = nxsp(await s.run(() => s.open.openRead(changed)))
    const stored = await s.run(() =>
        s.open.openStore(storeRequest(reply.id, { level: stateBatch(edited) })),
    )
    if (stored.kind !== 'stored') throw new Error('not stored')
    await runAll(s, reply.id, stored.batches)
    const entries = sessionEntries(s.world)
    assert.deepEqual(
        entries.slice(4).map((row) => [row.seq, row.kind, row.label, row.dirty]),
        [
            [5, 'edit', 'Changed outside the editor', false],
            [6, 'continue', 'Opened coconut.nxsp', false],
        ],
    )
    // The binding's state is the file's level; the stack holds the history's, then it.
    const head = toHex(stored.head)
    assert.notEqual(head, hashes[2])
    assert.equal(toHex((chainRow(s.world)?.file as { hash: Uint8Array }).hash), head)
    const { window, slots } = storedStack(s.world)
    assert.deepEqual(window, { base: 0, length: 4, index: 3 })
    assert.equal(toHex(slots![3]!.snapshot), head)
    assert.deepEqual(
        stackMismatches(storedStack(s.world), replay(entries as unknown as ReplayEntry[])),
        [],
    )
    assert.equal(chainRow(s.world)?.edited, undefined)
    assert.equal(DB_NAME, 'nse-local-data')
})

/** A file of many rows: an init, then exports of the same state, in the writer's segments. */
const longFile = async (count: number) => {
    const { input } = fresh()
    const history = input.history!
    const first = history.entries[0]!
    const head = history.undoStack.slots[2]!.snapshot
    const entries = [
        { ...first, snapshot: head },
        ...Array.from({ length: count - 2 }, (_, i) => ({
            kind: 'export' as const,
            time: 2000 + i,
            label: 'Exported LevelData',
            snapshot: head,
            noteCount: 0,
        })),
        { ...history.entries.at(-1)!, snapshot: head },
    ]
    const state = fresh().c
    const long = {
        ...input,
        ...headInputOf(state),
        media: { bgm: input.media!.bgm, cover: input.media!.cover, preview: input.media!.preview },
        history: {
            ...history,
            entries,
            undoStack: { base: 0, slots: [{ snapshot: head, label: first.label }], index: 0 },
        },
    }
    return executePlan(planNxsp(long).plan, new Map())
}

test('a long history’s rows come in batches after the first transaction', async () => {
    const s = await setup(8)
    const file = await longFile(2100)
    const reply = nxsp(await s.run(() => s.open.openRead(file)))
    assert.equal(reply.history?.entries, 2100)
    const stored = await s.run(() => s.open.openStore(storeRequest(reply.id)))
    if (stored.kind !== 'stored') throw new Error('not stored')
    // Only the open's own entry, at first.
    assert.deepEqual(
        sessionEntries(s.world).map((row) => row.seq),
        [2101],
    )
    const outcomes = await runAll(s, reply.id, stored.batches)
    assert.ok(outcomes.every((outcome) => outcome.kind === 'done'))
    const entries = sessionEntries(s.world)
    assert.equal(entries.length, 2101)
    assert.equal(sessionRow(s.world)?.entryCount, 2101)
    assert.deepEqual(
        stackMismatches(storedStack(s.world), replay(entries as unknown as ReplayEntry[])),
        [],
    )
})

test('a row the file flags kept: false whose root the file holds counts as held (D25)', async () => {
    const s = await setup(9)
    const { input } = fresh()
    const history = input.history!
    // A flagged row whose state a later row keeps: the file holds its root.
    const held = history.entries[2]!.snapshot
    const entries = history.entries.map((entry, i) =>
        i === 1 ? { ...entry, snapshot: held, kept: false as const } : entry,
    )
    const file = await executePlan(
        planNxsp({ ...input, history: { ...history, entries } }).plan,
        new Map(),
    )
    const reply = nxsp(await s.run(() => s.open.openRead(file)))
    assert.equal(reply.history?.notKept, 0)
    const stored = await s.run(() => s.open.openStore(storeRequest(reply.id)))
    if (stored.kind !== 'stored') throw new Error('not stored')
    const binding = chainRow(s.world)?.file as { entry: { count: number; notKept: number } }
    assert.equal(binding.entry.count, history.entries.length)
    assert.equal(binding.entry.notKept, 0)
})

test('an import abandoned before its rows batch never lets a later Save carry the file', async () => {
    const s = await setup(10)
    const file = await longFile(2100)
    const reply = nxsp(await s.run(() => s.open.openRead(file)))
    const stored = await s.run(() => s.open.openStore(storeRequest(reply.id)))
    if (stored.kind !== 'stored') throw new Error('not stored')
    assert.equal(await s.run(() => s.open.openAbandon(ids.sessionId)), true)
    // The binding keeps the file's counts; storage has none of the rows up to the cut.
    const binding = chainRow(s.world)?.file as {
        entry: { sessionId: string; seq: number; startedAt: number; count: number; notKept: number }
    }
    assert.deepEqual([binding.entry.count, binding.entry.notKept], [2100, 0])
    const startedAt = sessionRow(s.world)?.startedAt as number
    const rows = sessionEntries(s.world).map((entry) => ({
        entry: entry as unknown as ChainRow['entry'],
        startedAt,
    }))
    assert.equal(
        carries(rows, binding.entry, (row) => !row.entry.kept),
        false,
    )
})

test('a refused media Blob preserves the imported history and reports missing media', async () => {
    const s = await setup(112)
    const { file, hashes } = await freshFile()
    const reply = nxsp(await s.run(() => s.open.openRead(file)))
    s.world.memory.faults.refuseBlobs = true
    const stored = await s.run(() => s.open.openStore(storeRequest(reply.id)))
    assert.equal(stored.kind, 'stored')
    if (stored.kind !== 'stored') return
    await runAll(s, reply.id, stored.batches)
    assert.equal(s.page.core.status.mode, 'stored')
    assert.equal(s.page.core.status.reason, undefined)
    assert.equal(s.page.core.status.mediaPending?.length, 2)
    assert.equal(rows(s.world, 'media').size, 0)
    assert.equal(sessionRow(s.world)?.importPending, undefined)
    assert.equal(sessionEntries(s.world).length, 5)
    for (const hash of hashes) {
        assert.ok(storedRecords(s.world, fromHex16(hash)))
        assert.equal((await s.run(() => s.peek.readSnapshotVerified(hash))).kind, 'found')
    }
})
