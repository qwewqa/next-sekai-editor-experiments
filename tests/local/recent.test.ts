import assert from 'node:assert/strict'
import test from 'node:test'
import type { KvTx } from '../../src/local/kv/types'
import { captureMedia } from '../../src/local/media'
import { displayName, namePartsOf } from '../../src/local/names'
import { listRecent, type RecentChain } from '../../src/local/recent'
import { createWorld, type World } from '../../src/local/testing/world'
import { readTimeline } from '../../src/local/worker/timelineHandlers'
import type { State } from '../../src/state'
import { editStep, futureFixtureOperation } from '../helpers/historySteps'
import '../helpers/lockChecks'
import { openPage, workerCore } from './flush/harness'
import { goldenChart, stateOf } from './records/charts'
import { beginIn, continueIn, handlersOf, readOpen } from './startup/harness'
import { widen } from './timeline/helpers'

// Recent Sessions' list read: one row per chain, newest first, not
// the chains marked for Delete, and a failed read is a failure, never an empty list.

type Page = Awaited<ReturnType<typeof openPage>>

/** A stored chain with one edit; each later chain is newer. */
const chainIn = async (page: Page, state: State) => {
    const session = beginIn(page, state)
    page.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) },
        widen(state, 1),
        true,
    )
    await page.flusher.flush()
    return session
}

const tamper = async (world: World, change: (tx: KvTx) => Promise<void>) => {
    const tab = world.tab('tamper')
    const core = workerCore(world, tab)
    await tab.run(() => core.start())
    await tab.run(() => core.write(['sessions', 'chains', 'entries'], change))
}

type Row = Record<string, unknown>

const rowOf = async (tx: KvTx, store: string, key: string) => (await tx.get(store, key)) as Row

/** The list as the page reads it: through the worker's handler and the `storedRead` gate. */
const listed = async (page: Page): Promise<RecentChain[]> => {
    const handlers = handlersOf(page)
    const read = await listRecent({
        call: (method) => {
            assert.equal(method, 'listRecent')
            return page.tab.run(() => handlers.listRecent())
        },
    })
    assert.equal(read.storedRead, 'value')
    return read.storedRead === 'value' ? read.storedValue : []
}

const withSong = async (state: State, name: string): Promise<State> => {
    const bytes = new Uint8Array(2048)
    bytes.set([0x49, 0x44, 0x33, 0x04])
    const captured = await captureMedia(bytes.buffer, { name, type: '' })
    return {
        ...state,
        bgm: {
            ...state.bgm,
            meta: { ...captured.meta, durationMs: 1000 },
            source: captured.source,
        },
    }
}

test('chains are listed newest first, a chain marked for Delete is not', async () => {
    const world = createWorld({ seed: 1 })
    const page = await openPage(world, world.tab('a'))
    const a = stateOf(goldenChart())
    const oldest = await chainIn(page, a)
    const middle = await chainIn(page, widen(a, 10))
    const newest = await chainIn(page, widen(a, 20))
    assert.deepEqual(
        (await listed(page)).map((row) => row.chainId),
        [newest.chainId, middle.chainId, oldest.chainId],
    )
    await tamper(world, async (tx) => {
        await tx.put('chains', {
            ...(await rowOf(tx, 'chains', middle.chainId)),
            deleting: { at: 1 },
        })
    })
    const rows = await listed(page)
    assert.deepEqual(
        rows.map((row) => row.chainId),
        [newest.chainId, oldest.chainId],
    )
    assert.equal(rows[0]?.head.sessionId, newest.id)
    assert.equal(rows[0]?.head.lastSeq, 2)
})

test('changed compares the head’s root with the file’s hash; a file without one is changed', async () => {
    const world = createWorld({ seed: 2 })
    const page = await openPage(world, world.tab('a'))
    const a = stateOf(goldenChart())
    const same = await chainIn(page, a)
    const edited = await chainIn(page, widen(a, 10))
    const unhashed = await chainIn(page, widen(a, 20))
    const unbound = await chainIn(page, widen(a, 30))
    const head = (await readOpen(page, same.id)).head
    const file = { name: 'a.nxsp', event: 'saved', at: 5 }
    await tamper(world, async (tx) => {
        await tx.put('chains', {
            ...(await rowOf(tx, 'chains', same.chainId)),
            file: { ...file, hash: head },
        })
        // The file holds another state than the head.
        await tx.put('chains', {
            ...(await rowOf(tx, 'chains', edited.chainId)),
            file: { ...file, hash: new Uint8Array(head).fill(7) },
        })
        await tx.put('chains', { ...(await rowOf(tx, 'chains', unhashed.chainId)), file })
    })
    const byChain = new Map((await listed(page)).map((row) => [row.chainId, row]))
    assert.equal(byChain.get(same.chainId)?.changed, false)
    assert.equal(byChain.get(edited.chainId)?.changed, true)
    assert.equal(byChain.get(unhashed.chainId)?.changed, true)
    assert.equal(byChain.get(unbound.chainId)?.changed, false)
    assert.equal(byChain.get(unbound.chainId)?.file, undefined)
    assert.deepEqual(byChain.get(same.chainId)?.file, file)
})

test('the note count is the summary’s, and absent when unknown, never 0', async () => {
    const world = createWorld({ seed: 4 })
    const page = await openPage(world, world.tab('a'))
    const a = stateOf(goldenChart())
    const known = await chainIn(page, a)
    const unknown = await chainIn(page, widen(a, 10))
    const count = (await listed(page)).find((row) => row.chainId === known.chainId)?.noteCount
    assert.ok(count !== undefined && count > 0)
    await tamper(world, async (tx) => {
        const rest = { ...(await rowOf(tx, 'chains', unknown.chainId)) }
        Reflect.deleteProperty(rest, 'summary')
        await tx.put('chains', rest)
    })
    const row = (await listed(page)).find((each) => each.chainId === unknown.chainId)
    assert.ok(row)
    assert.equal('noteCount' in row, false)
})

test('a head this build can’t read is listed as newer or damaged, never hidden', async () => {
    const world = createWorld({ seed: 5 })
    const page = await openPage(world, world.tab('a'))
    const a = stateOf(goldenChart())
    const fine = await chainIn(page, a)
    const newer = await chainIn(page, widen(a, 10))
    const unsupported = await chainIn(page, widen(a, 20))
    const missing = await chainIn(page, widen(a, 30))
    await tamper(world, async (tx) => {
        await tx.put('sessions', { ...(await rowOf(tx, 'sessions', newer.id)), v: 99 })
        await tx.put('sessions', { ...(await rowOf(tx, 'sessions', unsupported.id)), v: 0 })
        await tx.delete('sessions', missing.id)
    })
    const readable = new Map((await listed(page)).map((row) => [row.chainId, row.readable]))
    assert.deepEqual(Object.fromEntries(readable), {
        [fine.chainId]: 'yes',
        [newer.chainId]: 'newer',
        [unsupported.chainId]: 'damaged',
        [missing.chainId]: 'damaged',
    })
})

test('a chain with one session this build can’t read is newer, as opening it would say', async () => {
    const world = createWorld({ seed: 6 })
    const page = await openPage(world, world.tab('a'))
    const first = await chainIn(page, stateOf(goldenChart()))
    await tamper(world, async (tx) => {
        await tx.put('sessions', { ...(await rowOf(tx, 'sessions', first.id)), v: 99 })
    })
    const [row] = await listed(page)
    assert.equal(row?.readable, 'newer')
    assert.equal((await page.tab.run(() => handlersOf(page).readSession(first.id))).kind, 'later')
})

test('a failed read is a failure, never an empty list', async () => {
    const read = await listRecent({
        call: () => Promise.reject(new Error('The database is closed')),
    })
    assert.equal(read.storedRead, 'failed')
})

test('a chart named by its song keeps that name in the list, as the live label shows it', async () => {
    const world = createWorld({ seed: 7 })
    const page = await openPage(world, world.tab('a'))
    const base = stateOf(goldenChart())
    const untitled = await withSong(
        { ...base, levelInfo: { ...base.levelInfo, title: '' } },
        'melt.mp3',
    )
    const session = await chainIn(page, untitled)
    const [row] = await listed(page)
    assert.equal(row?.chainId, session.chainId)
    const live = displayName(namePartsOf({}, untitled))
    assert.deepEqual(live, { kind: 'bgm', text: 'melt' })
    assert.deepEqual(displayName(row!.nameParts), live)
})

test('a title outranks the song in the list, as in the live label', async () => {
    const world = createWorld({ seed: 8 })
    const page = await openPage(world, world.tab('a'))
    const titled = await withSong(stateOf(goldenChart()), 'melt.mp3')
    await chainIn(page, titled)
    const [row] = await listed(page)
    assert.deepEqual(displayName(row!.nameParts), displayName(namePartsOf({}, titled)))
    assert.equal(displayName(row!.nameParts).kind, 'title')
})

test('an untitled chain is dated by its first start: a later visit does not rename it', async () => {
    const world = createWorld({ seed: 9 })
    const page = await openPage(world, world.tab('a'))
    const base = stateOf(goldenChart())
    const untitled = {
        ...base,
        levelInfo: { ...base.levelInfo, title: '' },
        bgm: { offset: base.bgm.offset },
    }
    const first = await chainIn(page, untitled)
    const [before] = await listed(page)
    // A second visit continues the chain as a new session, which starts later.
    const read = await readOpen(page, first.id)
    const later = continueIn(page, read)
    page.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('Later')) },
        widen(untitled, 2),
        true,
    )
    await page.flusher.flush()
    const head = await readOpen(page, later.id)
    assert.equal(head.chain.head, later.id)
    assert.notEqual(head.session.startedAt, read.session.startedAt)
    const [after] = await listed(page)
    assert.equal(displayName(after!.nameParts).kind, 'date')
    assert.equal(after!.head.startedAt, before!.head.startedAt)
    assert.equal(after!.head.startedAt, read.session.startedAt)

    // A fork is dated by its own start, not its source's.
    const fork = continueIn(page, head, { asFork: true })
    page.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('Fork')) },
        widen(untitled, 3),
        true,
    )
    await page.flusher.flush()
    const forked = (await listed(page)).find((row) => row.chainId === fork.chainId)
    assert.equal(forked?.head.startedAt, (await readOpen(page, fork.id)).session.startedAt)
    assert.notEqual(forked?.head.startedAt, read.session.startedAt)
})

test('a chain of three sessions is one row, and its restored Timeline shows a divider for each', async () => {
    const world = createWorld({ seed: 10 })
    const page = await openPage(world, world.tab('a'))
    let state = stateOf(goldenChart())
    const first = await chainIn(page, state)
    let head = first.id
    for (const label of ['Second', 'Third']) {
        const visit = continueIn(page, await readOpen(page, head))
        state = widen(state, 2)
        page.flusher.append(
            { kind: 'edit', step: editStep(futureFixtureOperation(label)) },
            state,
            true,
        )
        await page.flusher.flush()
        head = visit.id
    }
    const rows = await listed(page)
    assert.deepEqual(
        rows.map((row) => [row.chainId, row.head.sessionId]),
        [[first.chainId, head]],
    )
    // Restore Session continues the head, as a new session of the chain.
    const restored = continueIn(page, await readOpen(page, rows[0]!.head.sessionId))
    page.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('Restored')) },
        widen(state, 2),
        true,
    )
    await page.flusher.flush()
    const timeline = await page.tab.run(() =>
        page.core.read(['sessions', 'entries', 'chains', 'nodes'], (tx) =>
            readTimeline(tx, { sessionId: restored.id, limit: 100 }),
        ),
    )
    assert.equal(timeline.next, undefined)
    assert.equal(timeline.entries.filter((entry) => entry.kind === 'continue').length, 3)
    assert.equal(new Set(timeline.entries.map((entry) => entry.sessionId)).size, 4)
    assert.equal((await listed(page)).length, 1)
})
