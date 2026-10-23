import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveZone } from '../../../src/calendar/calendar'
import { writeMeta } from '../../../src/local/db'
import {
    BUSY_LIMIT_MS,
    BUSY_RETRY_MS,
    createDeleteSessions,
    type DeleteChain,
    type DeleteSessionsDeps,
} from '../../../src/local/deleteSessions'
import { importLock, MAINT_LOCK, sessionLock } from '../../../src/local/locks'
import { headOf } from '../../../src/local/open/earlier'
import { SESSION_V } from '../../../src/local/records/version'
import { checkStored } from '../../../src/local/testing/invariants'
import { createWorld, type World } from '../../../src/local/testing/world'
import '../../helpers/lockChecks'
import { closedChain, daysPass, MemoryStorage, openDeleter, tamper } from '../deletion/harness'
import { rows, workerCore } from '../flush/harness'

// Delete Sessions… (deletion design §3.6, Local Data design §3.7): the chains the dialog counts
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

/** The head session’s root: what a binding’s hash is compared with. */
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
        downloadsConfirmed: () => false,
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

test('ranges count calendar days in the page’s zone: 8 days ago is over 7 and not over 30', async () => {
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

test('the age follows the page’s zone, not 24-hour spans', async () => {
    const { world, chains, deleter, read } = await setup(1, {
        zone: () => resolveZone('Asia/Tokyo'),
    })
    // 23:00 UTC the day before NOW is 08:00 in Tokyo on NOW’s date (NOW is 21:00 there).
    await age(world, chains[0]!, Date.UTC(2026, 9, 22, 23))
    assert.equal((await read())[0]?.ageDays, 0)
    const utc = createDeleteSessions({
        worker: deleter.worker,
        locks: deleter.tab.locks,
        removeLocked: (request) => deleter.remove(request),
        downloadsConfirmed: () => false,
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
    // Its bodies go once past the grace period, and GC never reports a newer build’s data.
    await daysPass(world)
    const swept = await deleter.gc()
    assert.equal(swept?.kind, 'done')
    assert.deepEqual(checkStored(world.memory), [])
    await world.idle()
})

test('a chain is not saved when it has content in no file, or is bound and changed, or bound by a download not confirmed', async () => {
    const { world, chains, read, ds, deleter } = await setup(6)
    const [blank, content, saved, edited, downloaded, confirmed] = chains as [
        Chain,
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
    // Edited after the file event: the head’s root is not the file’s.
    await patchChain(world, edited, {
        file: { name: 'b.nxsp', event: 'saved', hash: new Uint8Array(16).fill(7) },
    })
    await patchChain(world, downloaded, {
        file: { name: 'c.nxsp', event: 'downloaded', ...(await hash(downloaded)) },
    })
    await patchChain(world, confirmed, {
        file: { name: 'd.nxsp', event: 'downloaded', confirmed: true, ...(await hash(confirmed)) },
    })
    const found = await read()
    const flags = chains.map((chain) => byChain(found, chain)?.notSaved)
    assert.deepEqual(flags, [false, true, false, true, true, false])
    // A download confirmed in this browser counts as saved.
    const here = createDeleteSessions({
        worker: deleter.worker,
        locks: deleter.tab.locks,
        removeLocked: (request) => deleter.remove(request),
        downloadsConfirmed: () => true,
        paused: () => undefined,
        retryStoring: () => Promise.resolve(),
        zone: () => UTC,
    })
    const again = await deleter.tab.run(() => here.readDeleteChoices())
    assert.equal(
        again.storedRead === 'value' && byChain(again.storedValue, downloaded)?.notSaved,
        false,
    )
    void ds
})

test('a chain whose file another chain took over counts as not saved, by its record or by a pending revocation', async () => {
    const pending = new Set<string>()
    const { world, chains, read } = await setup(2, { revoked: (id) => pending.has(id) })
    const [takenOver, revoking] = chains as [Chain, Chain]
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
    // A revocation storage could not take yet: the record still holds the binding.
    await patchChain(world, revoking, {
        hasContent: true,
        file: { name: 'b.nxsp', event: 'saved', hash: await rootOf(world, revoking) },
    })
    assert.equal(byChain(await read(), revoking)?.notSaved, false)
    pending.add(revoking.first.chainId)
    const found = await read()
    assert.equal(byChain(found, takenOver)?.notSaved, true)
    assert.equal(byChain(found, revoking)?.notSaved, true)
})

test('names are the displayed names, with the head’s start for the date fallback', async () => {
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
    // Another tab’s continuation added a session.
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
        downloadsConfirmed: () => false,
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

test('a damaged chain whose head session row is missing goes with that head’s entries and blocks', async () => {
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

test('a chain counted as saved whose file is taken over or revoked after the read is skipped', async () => {
    const pending = new Set<string>()
    const { world, chains, read, remove, calls } = await setup(3, {
        revoked: (id) => pending.has(id),
    })
    const [takenOver, revoked, rebound] = chains as [Chain, Chain, Chain]
    for (const chain of chains)
        await patchChain(world, chain, {
            hasContent: true,
            file: { name: 'a.nxsp', event: 'saved', at: NOW, hash: await rootOf(world, chain) },
        })
    const found = await read()
    assert.ok(found.every((chain) => !chain.notSaved))
    // Another tab’s picker overwrote the file: `takeOver` drops the binding, as it leaves `updatedAt`.
    await edit(world, async (tx) => {
        const row = (await tx.get('chains', takenOver.first.chainId)) as Record<string, unknown>
        const { file: _, ...rest } = row
        await tx.put('chains', { ...rest, replaced: { by: 'other', at: NOW, name: 'a.nxsp' } })
    })
    // A revocation storage could not take: only the localStorage key says so.
    pending.add(revoked.first.chainId)
    // Saved to another file since: a new binding.
    await patchChain(world, rebound, {
        file: { name: 'b.nxsp', event: 'saved', at: NOW + 1, hash: await rootOf(world, rebound) },
    })
    assert.deepEqual(await remove(found), { deleted: 0, skipped: 3 })
    for (const chain of chains) assert.ok(stored(world, chain))
    assert.deepEqual(calls.results, ['changed', 'changed'])
})
