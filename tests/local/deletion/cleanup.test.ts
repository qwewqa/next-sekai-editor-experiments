import assert from 'node:assert/strict'
import test from 'node:test'
import { removeCachedMedia, type CleanupResult } from '../../../src/local/cleanup'
import { DB_NAME, hashKey, writeMeta } from '../../../src/local/db'
import { heldMediaOf, type FlushDeps } from '../../../src/local/flush'
import { importLock, MAINT_LOCK } from '../../../src/local/locks'
import { captureMedia } from '../../../src/local/media'
import { headOf } from '../../../src/local/open/earlier'
import { RECORDS_V, SESSION_V } from '../../../src/local/records/version'
import { checkStored } from '../../../src/local/testing/invariants'
import { createWorld, type World } from '../../../src/local/testing/world'
import type { State } from '../../../src/state'
import { editStep, futureFixtureOperation, originOperation } from '../../helpers/historySteps'
import '../../helpers/lockChecks'
import { openPage, rows, testId } from '../flush/harness'
import { goldenChart, stateOf } from '../records/charts'
import { daysPass, MemoryStorage, openDeleter, tamper } from './harness'

// Cleanup under pressure: it removes only cached earlier
// media, the media rows no chain's latest state uses, past GC's grace period, largest first, in
// one transaction under `nse-maint` exclusive; never a Timeline row, session or chain.

/** A small MP3-looking file of `size` bytes. */
const song = (seed: number, size: number) => {
    const bytes = new Uint8Array(size)
    bytes.set([0x49, 0x44, 0x33, 0x04])
    for (let i = 4; i < bytes.length; i++) bytes[i] = (i * 31 + seed) & 0xff
    return bytes.buffer
}

const withSong = async (state: State, seed: number, size: number): Promise<State> => {
    const captured = await captureMedia(song(seed, size), { name: `song${seed}.mp3`, type: '' })
    return {
        ...state,
        bgm: {
            ...state.bgm,
            meta: { ...captured.meta, durationMs: 1000 },
            source: captured.source,
        },
    }
}

const hashOf = (state: State) => state.bgm.meta?.hash ?? ''

/**
 * A chain whose steps picked three songs in turn: `early` (the largest) and `middle` are only in
 * earlier steps, `head` is in its latest state. The page that stored it is still open.
 */
const stored = async (seed: number, deps: Partial<FlushDeps> = {}) => {
    const world = createWorld({ seed })
    const page = await openPage(world, world.tab('a'), deps)
    const early = await withSong(stateOf(goldenChart()), 1, 8192)
    page.flusher.begin({
        id: testId(),
        docId: testId(),
        origin: 'import',
        state: early,
        operation: originOperation('import'),
        dirty: false,
    })
    await page.flusher.flush({ strict: true })
    const middle = await withSong(early, 2, 2048)
    const toMiddle = editStep(futureFixtureOperation('Changed BGM'))
    page.flusher.append({ kind: 'edit', step: toMiddle }, middle, true)
    await page.flusher.flush({ strict: true })
    const head = await withSong(middle, 3, 4096)
    const toHead = editStep(futureFixtureOperation('Changed BGM again'))
    page.flusher.append({ kind: 'edit', step: toHead }, head, true)
    await page.flusher.flush({ strict: true })
    assert.equal(rows(world, 'media').size, 3)
    const deleter = await openDeleter(world, world.tab('cleaner'), new MemoryStorage())
    const clean = (bytes: number) =>
        deleter.worker.call('removeCachedMedia', { bytes } as never) as Promise<CleanupResult>
    return { world, page, deleter, clean, states: { early, middle, head }, toHead }
}

/** The media rows by hash. */
const media = (world: World) => new Set([...rows(world, 'media').keys()].map((key) => key.slice(1)))

const meta = (world: World, key: string) => rows(world, 'meta').get(key)?.value

/** Every store but the bodies and `meta`: what cleanup must never change. */
const history = (world: World) => {
    const dump = world.memory.dump(DB_NAME)
    return Object.fromEntries(
        ['chains', 'handles', 'sessions', 'entries', 'stackBlocks', 'nodes', 'chunks'].map(
            (store) => [store, dump.get(store) ?? []],
        ),
    )
}

test('cleanup removes only media no latest state uses, largest first until the bytes are freed, and no Timeline row', async () => {
    const { world, clean, states } = await stored(1)
    await daysPass(world)
    const before = history(world)
    const epoch = meta(world, 'epoch') as number
    // One byte asked for: the largest cached item alone.
    assert.deepEqual(await clean(1), { kind: 'removed', bytes: 8192, items: 1 })
    assert.deepEqual(media(world), new Set([hashOf(states.middle), hashOf(states.head)]))
    assert.equal(meta(world, 'epoch'), epoch + 1)
    assert.deepEqual(await clean(Number.MAX_SAFE_INTEGER), {
        kind: 'removed',
        bytes: 2048,
        items: 1,
    })
    // The latest state's BGM stays however much is asked for, and nothing removed bumps nothing.
    assert.deepEqual(await clean(Number.MAX_SAFE_INTEGER), { kind: 'removed', bytes: 0, items: 0 })
    assert.deepEqual(media(world), new Set([hashOf(states.head)]))
    assert.equal(meta(world, 'epoch'), epoch + 2)
    assert.deepEqual(history(world), before)
    assert.deepEqual(checkStored(world.memory), [])
})

test('the class is read in the removing transaction: a flush that made an earlier BGM current keeps it', async () => {
    const { world, page, clean, states, toHead } = await stored(2)
    await daysPass(world)
    // Undo back to the middle song, stored just before the cleanup.
    page.flusher.append({ kind: 'undo', step: toHead }, states.middle, false)
    await page.flusher.flush({ strict: true })
    assert.deepEqual(await clean(Number.MAX_SAFE_INTEGER), {
        kind: 'removed',
        bytes: 8192 + 4096,
        items: 2,
    })
    assert.deepEqual(media(world), new Set([hashOf(states.middle)]))
    assert.deepEqual(checkStored(world.memory), [])
})

test('media first stored within the grace period stays: a BGM just picked is not yet in a stored head', async () => {
    const { world, clean } = await stored(3)
    assert.deepEqual(await clean(Number.MAX_SAFE_INTEGER), { kind: 'removed', bytes: 0, items: 0 })
    await daysPass(world, 1)
    assert.deepEqual(await clean(Number.MAX_SAFE_INTEGER), { kind: 'removed', bytes: 0, items: 0 })
    await daysPass(world, 1)
    assert.equal((await clean(Number.MAX_SAFE_INTEGER)).kind, 'removed')
    assert.equal(media(world).size, 1)
})

test('a chain marked for Delete keeps its latest state’s BGM: Undo brings it back', async () => {
    const { world, page, deleter, clean, states } = await stored(4)
    await daysPass(world)
    page.tab.kill()
    await world.idle()
    const [chainId = ''] = rows(world, 'chains').keys()
    assert.equal((await deleter.mark(chainId)).kind, 'marked')
    assert.equal((await clean(Number.MAX_SAFE_INTEGER)).kind, 'removed')
    assert.deepEqual(media(world), new Set([hashOf(states.head)]))
})

test('a head session whose stack was removed keeps its last entry’s BGM', async () => {
    const { world, page, clean, states } = await stored(7)
    await daysPass(world)
    page.tab.kill()
    await world.idle()
    // As `stackRemoved` leaves it: no stack index and no blocks; replay rebuilds the stack.
    world.checks.lock = false
    await tamper(world, async (tx) => {
        const [session] = (await tx.getAll('sessions')) as Record<string, unknown>[]
        const rest = { ...session }
        delete rest.stack
        await tx.put('sessions', rest)
        for (const key of await tx.getAllKeys('stackBlocks')) await tx.delete('stackBlocks', key)
    })
    world.checks.lock = true
    assert.deepEqual(await clean(Number.MAX_SAFE_INTEGER), {
        kind: 'removed',
        bytes: 8192 + 2048,
        items: 2,
    })
    assert.deepEqual(media(world), new Set([hashOf(states.head)]))
})

test('an Undo onto a step whose BGM went stores it again when the tab attached it without a step', async () => {
    const live: { state?: State } = {}
    const { world, page, clean, states, toHead } = await stored(8, {
        liveHeld: () => (live.state ? heldMediaOf(live.state) : []),
    })
    await daysPass(world)
    assert.deepEqual(await clean(Number.MAX_SAFE_INTEGER), {
        kind: 'removed',
        bytes: 8192 + 2048,
        items: 2,
    })
    // A restored slot names its audio by hash only; the tab's cache attaches the bytes to the live
    // state without a step.
    const bgm = { ...states.middle.bgm }
    delete bgm.source
    live.state = states.middle
    page.flusher.append({ kind: 'undo', step: toHead }, { ...states.middle, bgm }, false)
    await page.flusher.flush({ strict: true })
    assert.deepEqual(media(world), new Set([hashOf(states.middle), hashOf(states.head)]))
    assert.deepEqual(checkStored(world.memory), [])
})

test('nothing is removed while a head root, a session or the database is of a newer version', async () => {
    const variants: [string, (tx: Parameters<Parameters<typeof tamper>[1]>[0]) => Promise<void>][] =
        [
            [
                'a session of a newer version',
                async (tx) => {
                    const [session] = (await tx.getAll('sessions')) as Record<string, unknown>[]
                    await tx.put('sessions', { ...session, v: SESSION_V + 1 })
                },
            ],
            [
                'a head root of a newer version',
                async (tx) => {
                    const [session] = (await tx.getAll('sessions')) as Record<string, unknown>[]
                    const root = (await headOf(tx, session ?? {})) as Uint8Array
                    const row = (await tx.get('nodes', hashKey(root))) as Record<string, unknown>
                    await tx.put('nodes', { ...row, v: RECORDS_V + 1 }, hashKey(root))
                },
            ],
            [
                'a newer database format',
                async (tx) => {
                    await writeMeta(tx, 'formatVersion', 2)
                },
            ],
        ]
    for (const [seed, [why, change]] of variants.entries()) {
        const { world, page, clean } = await stored(10 + seed)
        await daysPass(world)
        page.tab.kill()
        await world.idle()
        world.checks.lock = false
        await tamper(world, change)
        world.checks.lock = true
        const before = media(world)
        assert.deepEqual(await clean(Number.MAX_SAFE_INTEGER), { kind: 'unsafe', why })
        assert.deepEqual(media(world), before, why)
    }
})

test('cleanup is busy while an import runs or a writer holds nse-maint', async () => {
    const { world, clean } = await stored(5)
    await daysPass(world)
    const before = media(world)
    for (const [name, mode] of [
        [importLock('p'), 'exclusive'],
        [MAINT_LOCK, 'shared'],
    ] as const) {
        const holder = world.tab(`holder-${name}`)
        let release!: () => void
        const held = new Promise<void>((resolve) => (release = resolve))
        void holder.run(() => holder.locks.request(name, { mode }, () => held))
        await world.idle()
        assert.deepEqual(await clean(Number.MAX_SAFE_INTEGER), { kind: 'busy' }, name)
        assert.deepEqual(media(world), before)
        release()
        await world.idle()
    }
    assert.equal((await clean(Number.MAX_SAFE_INTEGER)).kind, 'removed')
    assert.equal(media(world).size, 1)
})

test('with storing paused for a full browser, cleanup still runs, and the test flag’s full ends', async () => {
    const { world } = await stored(6)
    await daysPass(world)
    // A tab whose browser is full until something is freed.
    const full = await openPage(world, world.tab('full'), {}, { flags: { quotaUntilFreed: true } })
    const write = () =>
        full.tab.run(() => full.core.write(['meta'], (tx) => writeMeta(tx, 'lastUseDate', 'x')))
    await assert.rejects(write())
    assert.deepEqual(full.core.status, { mode: 'stored', reason: 'full' })
    assert.deepEqual(await full.tab.run(() => removeCachedMedia(full.core, { bytes: 1 })), {
        kind: 'removed',
        bytes: 8192,
        items: 1,
    })
    await write()
    assert.deepEqual(full.core.status, { mode: 'stored' })
})
