import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveZone } from '../../../src/calendar/calendar'
import { readDeleteCandidates } from '../../../src/local/candidates'
import { chainStartOf } from '../../../src/local/chainFields'
import { writeMeta } from '../../../src/local/db'
import {
    BUSY_LIMIT_MS,
    BUSY_RETRY_MS,
    createDeleteSessions,
    type DeleteChain,
    type DeleteSessionsDeps,
} from '../../../src/local/deleteSessions'
import { equalBytes } from '../../../src/local/hash'
import type { KvTx } from '../../../src/local/kv/types'
import { importLock, MAINT_LOCK, sessionLock } from '../../../src/local/locks'
import { namePartsOf } from '../../../src/local/names'
import { headOf } from '../../../src/local/open/earlier'
import { readRecent } from '../../../src/local/recent'
import { sessionReadability } from '../../../src/local/records/unknownValues'
import { SESSION_V } from '../../../src/local/records/version'
import { checkStored } from '../../../src/local/testing/invariants'
import { createWorld, type World } from '../../../src/local/testing/world'
import '../../helpers/lockChecks'
import { closedChain, daysPass, MemoryStorage, openDeleter, tamper } from '../deletion/harness'
import { rows, workerCore } from '../flush/harness'

// Delete Sessions…: the chains the dialog counts
// (ranges by calendar days, open and marked chains left out, newer chains included and flagged,
// the not-saved test) and the removal of exactly the confirmed chains.

const DAY = 86_400_000
/** 2026-10-23, noon UTC. */
const NOW = Date.UTC(2026, 9, 23, 12)
const UTC = resolveZone('UTC')

type Chain = Awaited<ReturnType<typeof closedChain>>

/** Changes rows directly, as another build or an old profile would; the lock rule is off for it. */
const edit = async (world: World, change: Parameters<typeof tamper>[1]) => {
    world.checks.lock = false
    await tamper(world, change)
    world.checks.lock = true
}

const patchChain = (world: World, chain: Chain, patch: Record<string, unknown>) =>
    edit(world, async (tx) => {
        const row = (await tx.get('chains', chain.first.chainId)) as Record<string, unknown>
        await tx.put('chains', { ...row, ...patch })
    })

/** The head session's root: what a binding's hash is compared with. */
const rootOf = async (world: World, chain: Chain) => {
    const tab = world.tab(`root-${chain.second.id}`)
    const core = workerCore(world, tab)
    await tab.run(() => core.start())
    return tab.run(() =>
        core.read(['sessions', 'stackBlocks'], async (tx) => {
            const session = (await tx.get('sessions', chain.second.id)) as Record<string, unknown>
            return headOf(tx, session)
        }),
    )
}

/** A profile of `count` closed chains, oldest first, and a tab with Delete Sessions… over it. */
const setup = async (
    count: number,
    deps: Partial<DeleteSessionsDeps> = {},
    options: { journalLast?: boolean; seed?: number } = {},
) => {
    const world = createWorld({ seed: options.seed ?? 1 })
    const storage = new MemoryStorage()
    const chains: Chain[] = []
    for (let n = 0; n < count; n++)
        chains.push(await closedChain(world, storage, options.journalLast && n === count - 1))
    const deleter = await openDeleter(world, world.tab('b'), storage)
    const calls = {
        retried: 0,
        paused: undefined as 'full' | undefined,
        order: [] as string[],
        /** What each removal answered, in order. */
        results: [] as string[],
        sleeps: 0,
        failAt: undefined as number | undefined,
    }
    const ds = createDeleteSessions({
        worker: deleter.worker,
        locks: deleter.tab.locks,
        removeLocked: async (request) => {
            // The `failAt`th removal answers a worker failure.
            const result =
                calls.results.length + 1 === calls.failAt
                    ? ({ kind: 'failed' } as const)
                    : await deleter.remove(request)
            calls.results.push(result.kind)
            return result
        },
        paused: () => calls.paused,
        retryStoring: () => {
            calls.retried++
            calls.order.push('retry')
            return Promise.resolve()
        },
        gc: async () => {
            calls.order.push('gc')
            await deleter.gc()
        },
        zone: () => UTC,
        now: () => NOW,
        sleep: () => {
            calls.sleeps++
            return Promise.resolve()
        },
        ...deps,
    })
    const read = async () => {
        const result = await deleter.tab.run(() => ds.readDeleteChoices())
        assert.equal(result.storedRead, 'value')
        return result.storedRead === 'value' ? result.storedValue : []
    }
    const remove = (targets: readonly DeleteChain[], onProgress?: (done: number) => void) =>
        deleter.tab.run(() => ds.deleteSessions(targets, onProgress))
    return { world, storage, chains, deleter, ds, read, remove, calls }
}

/** Moves the chain's last edit to `at`, and the profile's clock to `NOW`. */
const age = (world: World, chain: Chain, at: number) =>
    edit(world, async (tx) => {
        const row = (await tx.get('chains', chain.first.chainId)) as Record<string, unknown>
        await tx.put('chains', { ...row, updatedAt: at })
        await writeMeta(tx, 'maxSeenTime', NOW - 1)
    })

const byChain = (found: DeleteChain[], chain: Chain) =>
    found.find((each) => each.chainId === chain.first.chainId)

const stored = (world: World, chain: Chain) => rows(world, 'chains').has(chain.first.chainId)

test("ranges count calendar days in the page's zone: 8 days ago is over 7 and not over 30", async () => {
    const ages = [2 * 3_600_000, 13 * 3_600_000, 7 * DAY, 8 * DAY, 31 * DAY]
    const { world, chains, read } = await setup(ages.length)
    for (const [n, chain] of chains.entries()) await age(world, chain, NOW - ages[n]!)
    const found = await read()
    assert.deepEqual(
        chains.map((chain) => byChain(found, chain)?.ageDays),
        // 2 h and 13 h ago are today and yesterday: the date changed, not 24 hours.
        [0, 1, 7, 8, 31],
    )
    const over = (days: number) =>
        found.filter((chain) => chain.ageDays > days).map((chain) => chain.chainId)
    const ids = (...picked: number[]) => picked.map((n) => chains[n]!.first.chainId).sort()
    assert.deepEqual(over(7).sort(), ids(3, 4))
    assert.deepEqual(over(30), ids(4))
    assert.deepEqual(over(1).sort(), ids(2, 3, 4))
    // Newest first, as Recent Sessions lists them.
    assert.deepEqual(
        found.map((chain) => chain.chainId),
        [0, 1, 2, 3, 4].map((n) => chains[n]!.first.chainId),
    )
})

test('the age follows the wall clock, not a clock that ran ahead and was corrected', async () => {
    const { world, chains, read } = await setup(2)
    await age(world, chains[0]!, NOW - DAY)
    await age(world, chains[1]!, NOW + 3 * DAY)
    // The device clock was a year ahead while the editor wrote; the user then corrected it.
    await edit(world, (tx) => writeMeta(tx, 'maxSeenTime', NOW + 365 * DAY))
    const found = await read()
    assert.deepEqual(
        chains.map((chain) => byChain(found, chain)?.ageDays),
        // Yesterday, and a last edit still ahead of the wall clock (never old).
        [1, 0],
    )
    assert.deepEqual(
        found.filter((chain) => chain.ageDays > 90),
        [],
    )
})

test("the age follows the page's zone, not 24-hour spans", async () => {
    const { world, chains, deleter, read } = await setup(1, {
        zone: () => resolveZone('Asia/Tokyo'),
    })
    // 23:00 UTC the day before NOW is 08:00 in Tokyo on NOW's date (NOW is 21:00 there).
    await age(world, chains[0]!, Date.UTC(2026, 9, 22, 23))
    assert.equal((await read())[0]?.ageDays, 0)
    const utc = createDeleteSessions({
        worker: deleter.worker,
        locks: deleter.tab.locks,
        removeLocked: (request) => deleter.remove(request),
        paused: () => undefined,
        retryStoring: () => Promise.resolve(),
        zone: () => UTC,
        now: () => NOW,
    })
    const result = await deleter.tab.run(() => utc.readDeleteChoices())
    assert.equal(result.storedRead === 'value' && result.storedValue[0]?.ageDays, 1)
})

test('chains held open now, by a session or an import, and chains marked for Delete are left out', async () => {
    const { world, chains, deleter, read } = await setup(4)
    const [open, importing, marked, plain] = chains as [Chain, Chain, Chain, Chain]
    const holder = world.tab('holder')
    const releases: (() => void)[] = []
    for (const name of [sessionLock(open.first.id), importLock(importing.second.id)])
        void holder.run(() =>
            holder.locks.request(
                name,
                { mode: 'exclusive' },
                () => new Promise<void>((resolve) => releases.push(resolve)),
            ),
        )
    await world.idle()
    assert.equal((await deleter.mark(marked.first.chainId)).kind, 'marked')
    assert.deepEqual(
        (await read()).map((chain) => chain.chainId),
        [plain.first.chainId],
    )
    // Once the holders let go, the open and importing chains are back; the marked one stays out.
    for (const release of releases) release()
    await world.idle()
    assert.deepEqual(
        (await read()).map((chain) => chain.chainId).sort(),
        [open, importing, plain].map((chain) => chain.first.chainId).sort(),
    )
})

test('a chain with a session of a newer version is included, flagged and counted as not saved, and deleting it leaves GC safe', async () => {
    const { world, chains, deleter, read, remove } = await setup(2)
    const [newer, plain] = chains as [Chain, Chain]
    await edit(world, async (tx) => {
        const head = (await tx.get('sessions', newer.second.id)) as Record<string, unknown>
        await tx.put('sessions', { ...head, v: SESSION_V + 1 })
    })
    await patchChain(world, newer, { hasContent: undefined })
    const found = await read()
    assert.equal(byChain(found, newer)?.readable, 'newer')
    assert.equal(byChain(found, newer)?.notSaved, true)
    assert.equal(byChain(found, plain)?.readable, 'yes')
    assert.deepEqual(await remove(found.filter((chain) => chain.readable === 'newer')), {
        deleted: 1,
        skipped: 0,
    })
    assert.ok(!stored(world, newer))
    assert.ok(stored(world, plain))
    // Its bodies go once past the grace period, and GC never reports a newer build's data.
    await daysPass(world)
    const swept = await deleter.gc()
    assert.equal(swept?.kind, 'done')
    assert.deepEqual(checkStored(world.memory), [])
    await world.idle()
})

test('a chain is not saved when it has content in no file, or is bound and changed; a download counts as the file', async () => {
    const { world, chains, read } = await setup(5)
    const [blank, content, saved, edited, downloaded] = chains as [
        Chain,
        Chain,
        Chain,
        Chain,
        Chain,
    ]
    const hash = async (chain: Chain) => ({ hash: await rootOf(world, chain) })
    await patchChain(world, blank, { hasContent: undefined, edited: undefined })
    await patchChain(world, content, { hasContent: true })
    await patchChain(world, saved, {
        hasContent: true,
        file: { name: 'a.nxsp', event: 'saved', ...(await hash(saved)) },
    })
    // Edited after the file event: the head's root is not the file's.
    await patchChain(world, edited, {
        file: { name: 'b.nxsp', event: 'saved', hash: new Uint8Array(16).fill(7) },
    })
    await patchChain(world, downloaded, {
        file: { name: 'c.nxsp', event: 'downloaded', ...(await hash(downloaded)) },
    })
    const found = await read()
    const flags = chains.map((chain) => byChain(found, chain)?.notSaved)
    assert.deepEqual(flags, [false, true, false, true, false])
})

test('a chain whose file another chain took over counts as not saved', async () => {
    const { world, chains, read } = await setup(1)
    const [takenOver] = chains as [Chain]
    // As `takeOver` leaves the owner: no binding, `replaced`, edited, with content.
    await edit(world, async (tx) => {
        const row = (await tx.get('chains', takenOver.first.chainId)) as Record<string, unknown>
        const rest = { ...row }
        delete rest.file
        await tx.put('chains', {
            ...rest,
            replaced: { by: 'other', at: NOW, name: 'a.nxsp' },
            edited: true,
            hasContent: true,
        })
    })
    assert.equal(byChain(await read(), takenOver)?.notSaved, true)
})

test("names are the displayed names, with the head's start for the date fallback", async () => {
    const { world, chains, read } = await setup(2)
    await patchChain(world, chains[0]!, { name: 'Stage 3' })
    const found = await read()
    const named = byChain(found, chains[0]!)
    assert.deepEqual(named?.name.name, { kind: 'name', text: 'Stage 3' })
    const unnamed = byChain(found, chains[1]!)
    assert.ok(unnamed && typeof unnamed.name.at === 'number')
})

test('exactly the confirmed chains go, whole, whatever else is in range; progress hears each', async () => {
    const { world, chains, read, remove, deleter } = await setup(4)
    const found = await read()
    // A chain that appears after the read is in no list, so it stays.
    const late = await closedChain(world, new MemoryStorage())
    const targets = found.filter((chain) =>
        [chains[0], chains[2]].some((each) => each?.first.chainId === chain.chainId),
    )
    const progress: number[] = []
    assert.deepEqual(await remove(targets, (done) => progress.push(done)), {
        deleted: 2,
        skipped: 0,
    })
    assert.deepEqual(progress, [1, 2])
    assert.deepEqual(
        chains.map((chain) => stored(world, chain)),
        [false, true, false, true],
    )
    assert.ok(stored(world, late))
    for (const gone of [chains[0]!, chains[2]!]) {
        const sessions = [gone.first.id, gone.second.id]
        assert.ok(!sessions.some((id) => rows(world, 'sessions').has(id)))
        assert.ok(
            ![...rows(world, 'entries').values()].some((row) =>
                sessions.includes(row.sessionId as string),
            ),
        )
    }
    assert.deepEqual(checkStored(world.memory), [])
    void deleter
})

test('a chain opened, given a journal, edited or continued since the read is skipped, with its rows kept', async () => {
    const { world, chains, read, remove, calls } = await setup(4, {}, { journalLast: true })
    const [opened, edited, continued, journalled] = chains as [Chain, Chain, Chain, Chain]
    const found = await read()
    assert.equal(found.length, 4)
    // Opened in another tab after the read.
    const holder = world.tab('holder')
    let release!: () => void
    void holder.run(() =>
        holder.locks.request(
            sessionLock(opened.second.id),
            { mode: 'exclusive' },
            () => new Promise<void>((resolve) => (release = resolve)),
        ),
    )
    await world.idle()
    // Edited since: its last write moved.
    await edit(world, async (tx) => {
        const row = (await tx.get('chains', edited.first.chainId)) as Record<string, unknown>
        await tx.put('chains', { ...row, updatedAt: (row.updatedAt as number) + 1 })
    })
    // Another tab's continuation added a session.
    await edit(world, async (tx) => {
        const head = (await tx.get('sessions', continued.second.id)) as Record<string, unknown>
        await tx.put('sessions', { ...head, id: 'continuation', startedAt: NOW })
        const row = (await tx.get('chains', continued.first.chainId)) as Record<string, unknown>
        await tx.put('chains', { ...row, head: 'continuation' })
    })
    assert.deepEqual(await remove(found), { deleted: 0, skipped: 4 })
    // Newest first: the journalled chain, the continued one, the edited one, the opened one.
    assert.deepEqual(calls.results, ['journal', 'changed', 'changed', 'open'])
    for (const chain of [opened, edited, continued, journalled]) assert.ok(stored(world, chain))
    // Nothing was deleted, so nothing was swept and storing was not asked again.
    assert.deepEqual(calls.order, [])
    release()
    await world.idle()
})

test('a busy nse-maint is retried about every 200 ms, and the chain goes once it is free', async () => {
    let release!: () => void
    const ref: { writer?: ReturnType<World['tab']> } = {}
    const { world, chains, read, remove, calls } = await setup(2, {
        sleep: () => {
            calls.sleeps++
            if (calls.sleeps === 3) release()
            return Promise.resolve()
        },
    })
    const writer = world.tab('writer')
    ref.writer = writer
    void writer.run(() =>
        writer.locks.request(
            MAINT_LOCK,
            { mode: 'shared' },
            () => new Promise<void>((resolve) => (release = resolve)),
        ),
    )
    await world.idle()
    const result = await remove(await read())
    assert.deepEqual(result, { deleted: 2, skipped: 0 })
    assert.ok(calls.sleeps >= 3 && calls.sleeps < 10, String(calls.sleeps))
    assert.equal(calls.results.filter((kind) => kind === 'busy').length, calls.sleeps)
    for (const chain of chains) assert.ok(!stored(world, chain))
})

test('a busy nse-maint is waited for at most 10 s in all; later chains are tried once and skipped', async () => {
    const { world, chains, read, remove, calls } = await setup(3)
    const writer = world.tab('writer')
    let release!: () => void
    void writer.run(() =>
        writer.locks.request(
            MAINT_LOCK,
            { mode: 'shared' },
            () => new Promise<void>((resolve) => (release = resolve)),
        ),
    )
    await world.idle()
    const progress: number[] = []
    const result = await remove(await read(), (done) => progress.push(done))
    assert.deepEqual(result, { deleted: 0, skipped: 3 })
    assert.equal(calls.sleeps, BUSY_LIMIT_MS / BUSY_RETRY_MS)
    // The first chain was tried 51 times; each later one once.
    assert.equal(calls.results.length, BUSY_LIMIT_MS / BUSY_RETRY_MS + 1 + 2)
    assert.deepEqual(progress, [1, 2, 3])
    for (const chain of chains) assert.ok(stored(world, chain))
    // Nothing deleted: no GC, no retry.
    assert.deepEqual(calls.order, [])
    release()
    await world.idle()
})

test('after the removals GC runs, then Try Again for storing only when storing is paused full', async () => {
    for (const [paused, order] of [
        ['full', ['gc', 'retry']],
        [undefined, ['gc']],
    ] as const) {
        const { read, remove, calls } = await setup(2)
        calls.paused = paused
        assert.deepEqual(await remove(await read()), { deleted: 2, skipped: 0 })
        assert.deepEqual(calls.order, order, String(paused))
    }
    // A run that deleted nothing sweeps nothing and asks for nothing.
    const none = await setup(1)
    none.calls.paused = 'full'
    assert.deepEqual(await none.remove([]), { deleted: 0, skipped: 0 })
    assert.deepEqual(none.calls.order, [])
})

test('the orphan reclaim runs after the removals and before GC and Try Again, so freed space is real', async () => {
    // A full browser: the kept copies of a deleted chain are still on disk until the reclaim.
    const shared: { order?: string[] } = {}
    const { read, remove, calls } = await setup(2, {
        reclaim: () => {
            shared.order?.push('reclaim')
            return Promise.resolve()
        },
    })
    shared.order = calls.order
    calls.paused = 'full'
    assert.deepEqual(await remove(await read()), { deleted: 2, skipped: 0 })
    assert.deepEqual(calls.order, ['reclaim', 'gc', 'retry'])
    // Nothing deleted: nothing to reclaim.
    const none = await setup(1, { reclaim: () => Promise.reject(new Error('must not run')) })
    assert.deepEqual(await none.remove([]), { deleted: 0, skipped: 0 })
    // A reclaim that fails does not stop GC or Try Again.
    const broken = await setup(1, { reclaim: () => Promise.reject(new Error('disk')) })
    broken.calls.paused = 'full'
    assert.deepEqual(await broken.remove(await broken.read()), { deleted: 1, skipped: 0 })
    assert.deepEqual(broken.calls.order, ['gc', 'retry'])
})

test('a failed removal stops the run with what was deleted, and GC still runs', async () => {
    const { world, chains, read, remove, calls } = await setup(3)
    calls.failAt = 2
    calls.paused = 'full'
    const found = await read()
    assert.deepEqual(await remove(found), { kind: 'failed', deleted: 1 })
    // Newest first: the newest went, the second failed, the third was never tried.
    assert.deepEqual(
        chains.map((chain) => stored(world, chain)),
        [true, true, false],
    )
    assert.deepEqual(calls.order, ['gc', 'retry'])
})

test('a signal stops between chains; a read that cannot list is a failure, never an empty list', async () => {
    const { chains, read, ds, world, deleter } = await setup(3)
    const found = await read()
    const controller = new AbortController()
    const result = await deleter.tab.run(() =>
        ds.deleteSessions(found, () => controller.abort(), controller.signal),
    )
    assert.deepEqual(result, { deleted: 1, skipped: 0 })
    assert.equal(chains.filter((chain) => stored(world, chain)).length, 2)
    const broken = createDeleteSessions({
        worker: {
            call: () => Promise.reject(new Error('The storage worker restarted')),
        },
        locks: deleter.tab.locks,
        removeLocked: () => Promise.resolve({ kind: 'failed' }),
        paused: () => undefined,
        retryStoring: () => Promise.resolve(),
    })
    assert.equal((await broken.readDeleteChoices()).storedRead, 'failed')
})

test('a damaged chain (no head id) is included, counted as not saved, and deleted', async () => {
    const { world, chains, read, remove } = await setup(2)
    const [damaged, plain] = chains as [Chain, Chain]
    await edit(world, async (tx) => {
        const chain = (await tx.get('chains', damaged.first.chainId)) as Record<string, unknown>
        const rest = { ...chain }
        delete rest.head
        await tx.put('chains', rest)
    })
    // It even claims a file that is unchanged: a chain this build cannot read counts as not saved.
    await patchChain(world, damaged, {
        file: { name: 'a.nxsp', event: 'saved', hash: new Uint8Array(16) },
    })
    const found = await read()
    const entry = byChain(found, damaged)
    assert.equal(entry?.readable, 'damaged')
    assert.equal(entry?.head, undefined)
    assert.equal(entry?.notSaved, true)
    assert.equal(byChain(found, plain)?.readable, 'yes')
    assert.deepEqual(await remove(found.filter((chain) => chain.readable === 'damaged')), {
        deleted: 1,
        skipped: 0,
    })
    assert.ok(!stored(world, damaged))
    assert.ok(stored(world, plain))
    assert.deepEqual(checkStored(world.memory), [])
    await world.idle()
})

test("a damaged chain whose head session row is missing goes with that head's entries and blocks", async () => {
    const { world, chains, read, remove } = await setup(2)
    const [damaged, plain] = chains as [Chain, Chain]
    const head = damaged.second.id
    await edit(world, (tx) => tx.delete('sessions', head))
    const of = (store: string) =>
        [...rows(world, store).values()].filter(
            (row) => (row as { sessionId?: string }).sessionId === head,
        )
    assert.ok(of('entries').length && of('stackBlocks').length)
    const found = await read()
    assert.equal(byChain(found, damaged)?.readable, 'damaged')
    assert.deepEqual(await remove(found.filter((chain) => chain.readable === 'damaged')), {
        deleted: 1,
        skipped: 0,
    })
    assert.ok(!stored(world, damaged))
    assert.deepEqual([of('entries').length, of('stackBlocks').length], [0, 0])
    assert.ok(stored(world, plain))
    await world.idle()
})

test('a chain counted as saved whose file is taken over or rebound after the read is skipped', async () => {
    const { world, chains, read, remove, calls } = await setup(2)
    const [takenOver, rebound] = chains as [Chain, Chain]
    for (const chain of chains)
        await patchChain(world, chain, {
            hasContent: true,
            file: { name: 'a.nxsp', event: 'saved', at: NOW, hash: await rootOf(world, chain) },
        })
    const found = await read()
    assert.ok(found.every((chain) => !chain.notSaved))
    // Another tab's picker overwrote the file: `takeOver` drops the binding, as it leaves `updatedAt`.
    await edit(world, async (tx) => {
        const row = (await tx.get('chains', takenOver.first.chainId)) as Record<string, unknown>
        const rest = { ...row }
        delete rest.file
        await tx.put('chains', { ...rest, replaced: { by: 'other', at: NOW, name: 'a.nxsp' } })
    })
    // Saved to another file since: a new binding.
    await patchChain(world, rebound, {
        file: { name: 'b.nxsp', event: 'saved', at: NOW + 1, hash: await rootOf(world, rebound) },
    })
    assert.deepEqual(await remove(found), { deleted: 0, skipped: 2 })
    for (const chain of chains) assert.ok(stored(world, chain))
    assert.deepEqual(calls.results, ['changed', 'changed'])
})

/** The candidates as they were read before the one-cursor read: one read per chain and session. */
const candidatesPerChain = async (tx: KvTx) => {
    type Row = Record<string, unknown>
    const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null
    const chains: unknown[] = []
    for (const { value } of await tx.entries('chains', { index: 'updatedAt', direction: 'prev' })) {
        if (!isRow(value) || value.deleting !== undefined || typeof value.chainId !== 'string')
            continue
        const sessionId = typeof value.head === 'string' ? value.head : ''
        const session = sessionId ? await tx.get('sessions', sessionId) : undefined
        const head = isRow(session) ? session : undefined
        const root = head ? await headOf(tx, head) : undefined
        const file = isRow(value.file) && typeof value.file.name === 'string' && value.file.name
        const hash = isRow(value.file) ? value.file.hash : undefined
        let readable = head ? 'yes' : 'damaged'
        for (const row of [
            head,
            ...(await tx.index('sessions', 'chainId').getAll(value.chainId)),
        ]) {
            if (!isRow(row)) readable = 'damaged'
            else if (sessionReadability({ row }) === 'newer') {
                readable = 'newer'
                break
            } else if (sessionReadability({ row }) === 'unsupported') readable = 'damaged'
        }
        const record = (await tx.get('chains', value.chainId)) as Row
        const sessions = (await tx.index('sessions', 'chainId').getAll(value.chainId))
            .filter(isRow)
            .sort((a, b) => Number(a.startedAt) - Number(b.startedAt))
        chains.push({
            chainId: value.chainId,
            head: sessionId || undefined,
            fileAt: isRow(record.file) ? record.file.at : undefined,
            sessions: sessions.map((row) => String(row.id)),
            changed: !!file && (!(hash instanceof Uint8Array) || !root || !equalBytes(root, hash)),
            readable,
            hasContent: record.hasContent === true,
        })
    }
    return chains
}

/** Recent Sessions' list as it was read before the one-cursor read: one read per chain and session. */
const recentPerChain = async (tx: KvTx) => {
    type Row = Record<string, unknown>
    const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null
    const count = (value: unknown) =>
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
    const out: unknown[] = []
    for (const { value } of await tx.entries('chains', { index: 'updatedAt', direction: 'prev' })) {
        if (!isRow(value) || value.deleting !== undefined || typeof value.chainId !== 'string')
            continue
        const sessionId = typeof value.head === 'string' ? value.head : ''
        const session = sessionId ? await tx.get('sessions', sessionId) : undefined
        const head = isRow(session) ? session : undefined
        const updatedAt = count(value.updatedAt) ?? 0
        const fileRow = isRow(value.file) ? value.file : undefined
        const file =
            fileRow && typeof fileRow.name === 'string' && fileRow.name
                ? {
                      name: fileRow.name,
                      ...(typeof fileRow.event === 'string' ? { event: fileRow.event } : {}),
                      ...(typeof fileRow.at === 'number' && Number.isFinite(fileRow.at)
                          ? { at: fileRow.at }
                          : {}),
                  }
                : undefined
        const root = head ? await headOf(tx, head) : undefined
        const hash = fileRow?.hash
        const summary = isRow(value.summary) ? value.summary : undefined
        const noteCount = count(summary?.noteCount)
        let readable = head ? 'yes' : 'damaged'
        for (const row of [
            head,
            ...(await tx.index('sessions', 'chainId').getAll(value.chainId)),
        ]) {
            if (!isRow(row)) readable = 'damaged'
            else if (sessionReadability({ row }) === 'newer') {
                readable = 'newer'
                break
            } else if (sessionReadability({ row }) === 'unsupported') readable = 'damaged'
        }
        out.push({
            chainId: value.chainId,
            updatedAt,
            head: {
                sessionId,
                lastSeq: count(head?.lastSeq) ?? 0,
                startedAt: count(chainStartOf(value, head?.startedAt)) ?? updatedAt,
            },
            nameParts: namePartsOf(value),
            ...(file ? { file } : {}),
            changed: !!file && (!(hash instanceof Uint8Array) || !root || !equalBytes(root, hash)),
            ...(noteCount === undefined ? {} : { noteCount }),
            readable,
        })
    }
    return out
}

test("the candidates and Recent Sessions' list read in one cursor are the ones read chain by chain, damage and all", async () => {
    const { world, chains, deleter } = await setup(9)
    const [marked, headless, missingHead, newer, unsupported, bound, changed, extra] =
        chains as Chain[] as [Chain, Chain, Chain, Chain, Chain, Chain, Chain, Chain]
    await patchChain(world, marked, { deleting: { at: NOW } })
    await edit(world, async (tx) => {
        const row = (await tx.get('chains', headless.first.chainId)) as Record<string, unknown>
        const rest = { ...row }
        delete rest.head
        await tx.put('chains', rest)
        await tx.delete('sessions', missingHead.second.id)
        const head = (await tx.get('sessions', newer.second.id)) as Record<string, unknown>
        await tx.put('sessions', { ...head, v: SESSION_V + 1 })
        const old = (await tx.get('sessions', unsupported.first.id)) as Record<string, unknown>
        await tx.put('sessions', { ...old, v: 0 })
        // A session moved to another chain, started earlier than that chain's own.
        const moved = (await tx.get('sessions', extra.first.id)) as Record<string, unknown>
        await tx.put('sessions', { ...moved, chainId: bound.first.chainId, startedAt: 1 })
    })
    await patchChain(world, bound, {
        hasContent: true,
        file: { name: 'a.nxsp', event: 'saved', at: NOW - DAY, hash: await rootOf(world, bound) },
    })
    await patchChain(world, changed, {
        file: { name: 'b.nxsp', event: 'saved', hash: new Uint8Array(16).fill(7) },
        summary: { noteCount: 12 },
        name: 'Stage 3',
    })
    const read = <T>(fn: (tx: KvTx) => Promise<T>) =>
        deleter.tab.run(() => deleter.core.read(['chains', 'sessions', 'stackBlocks', 'meta'], fn))
    const found = await read(readDeleteCandidates)
    const expected = await read(candidatesPerChain)
    // Recent Sessions' list, every field, is the one read chain by chain.
    assert.deepEqual(await read(readRecent), await read(recentPerChain))
    assert.deepEqual(
        found.map((chain) => ({
            chainId: chain.chainId,
            head: chain.head,
            fileAt: chain.fileAt,
            sessions: chain.sessions,
            changed: chain.changed,
            readable: chain.readable,
            hasContent: chain.hasContent,
        })),
        expected,
    )
    // Every kind of chain is there: the marked one left out, the rest in.
    assert.equal(found.length, 8)
    assert.deepEqual(
        [headless, missingHead, newer, unsupported, changed].map(
            (chain) => found.find((each) => each.chainId === chain.first.chainId)?.readable,
        ),
        ['damaged', 'damaged', 'newer', 'damaged', 'yes'],
    )
})
