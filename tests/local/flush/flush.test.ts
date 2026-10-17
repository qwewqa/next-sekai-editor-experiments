import assert from 'node:assert/strict'
import test from 'node:test'
import { setDeflateHookForTests } from '../../../src/local/chunkVerify'
import { bumpEpoch, hashKey } from '../../../src/local/db'
import { toRecords } from '../../../src/local/records/records'
import { checkStored } from '../../../src/local/testing/invariants'
import { crashSweep } from '../../../src/local/testing/sweep'
import { CI_SEEDS, createWorld } from '../../../src/local/testing/world'
import { StoragePausedError } from '../../../src/local/worker/core'
import type { State } from '../../../src/state'
import { replaceNote } from '../../../src/state/mutations/slides/note'
import { createTransaction, type Transaction } from '../../../src/state/transaction'
import { goldenChart, recordsText, stateOf } from '../records/charts'
import { sampleState } from '../records/samples'
import { openPage, rows, storedRecords, testId, workerCore, type Page } from './harness'

// The flush on the test core (§1.6.4 step 2): sessions and chains from their first applicable
// write, the epoch's closure check, the head check, field-level writes, and crashes at every await.

const edit = (state: State, change: (transaction: Transaction) => void) => {
    const transaction = createTransaction(state)
    change(transaction)
    return transaction.commit([])
}

/** The state with its n-th note one quarter wider. */
const widen = (state: State, n = 0) => {
    const notes = [...state.store.slides.note.values()].flat()

    const target = notes[n % notes.length]!
    return edit(state, (t) => {
        replaceNote(t, target, { ...target, size: target.size + 0.25 })
    })
}

const begin = (page: Page, state: State, origin: 'new' | 'import' = 'new') =>
    page.flusher.begin({
        id: testId(),
        docId: testId(),
        origin,
        state,
        label: () => 'Initialize',
        dirty: false,
    })

test('a blank start is stored from its first edit, with its chain record', async () => {
    const world = createWorld({ seed: 1 })
    const page = await openPage(world, world.tab('a'))
    const blank = stateOf(goldenChart())
    const session = begin(page, blank)
    await page.flusher.flush()
    assert.equal(page.batches.length, 0)
    assert.equal(rows(world, 'sessions').size, 0)

    const edited = widen(blank)
    page.flusher.append('edit', () => 'Changed note', edited, true)
    await page.flusher.flush()
    assert.deepEqual(page.errors, [])

    const [sessionRow] = rows(world, 'sessions').values()
    assert.ok(sessionRow)
    assert.equal(sessionRow.id, session.id)
    assert.equal(sessionRow.chainId, session.chainId)
    assert.equal(sessionRow.origin, 'new')
    assert.equal(sessionRow.lastSeq, 2)
    assert.equal(sessionRow.entryCount, 2)
    assert.equal(sessionRow.day, 1)
    assert.equal(sessionRow.appVersion, '0.6.0')
    assert.equal(typeof sessionRow.startedAt, 'number')
    assert.ok((sessionRow.updatedAt as number) > (sessionRow.startedAt as number))

    const [chain] = rows(world, 'chains').values()
    assert.ok(chain)
    assert.equal(chain.chainId, session.chainId)
    assert.equal(chain.head, session.id)
    assert.equal(chain.docId, session.docId)
    assert.equal(chain.lineageId, session.lineageId)
    assert.equal(chain.edited, true)
    assert.equal(chain.hasContent, true)
    assert.equal(chain.day, 1)
    assert.equal(chain.updatedAt, sessionRow.updatedAt)
    assert.deepEqual(chain.summary, {
        title: 'Golden',
        artists: 'Composer feat. Singer',
        author: 'Charter',
        rating: 12,
        tags: ['Tag', 'Icon tag'],
        noteCount: toRecords(edited).kinds[0]?.records.reduce(
            (n, { record }) => n + record.length,
            0,
        ),
    })

    const entries = [...rows(world, 'entries').values()]
    assert.deepEqual(
        entries.map(({ seq, kind, label, kept, dirty, day }) => ({
            seq,
            kind,
            label,
            kept,
            dirty,
            day,
        })),
        [
            { seq: 1, kind: 'init', label: 'Initialize', kept: true, dirty: false, day: 1 },
            { seq: 2, kind: 'edit', label: 'Changed note', kept: true, dirty: true, day: 1 },
        ],
    )
    assert.ok((entries[1]?.time as number) > (entries[0]?.time as number))
    // Each entry's snapshot decodes to the state it was made from.
    for (const [i, state] of [blank, edited].entries())
        assert.equal(
            recordsText(storedRecords(world, entries[i]?.snapshot as Uint8Array)),
            recordsText(toRecords(state)),
        )
    assert.deepEqual(checkStored(world.memory), [])
    const meta = rows(world, 'meta')
    assert.equal(meta.get('daysOfUse')?.value, 1)
})

test('an import is stored at once, with content and no edits', async () => {
    const world = createWorld({ seed: 2 })
    const page = await openPage(world, world.tab('a'))
    begin(page, stateOf(goldenChart()), 'import')
    await page.flusher.flush()
    assert.deepEqual(page.errors, [])
    const [chain] = rows(world, 'chains').values()
    assert.equal(chain?.hasContent, true)
    assert.equal(chain?.edited, undefined)
    assert.equal(page.batches[0]?.durability, 'strict')
    const [session] = rows(world, 'sessions').values()
    assert.equal(session?.origin, 'import')
    assert.equal(session?.lastSeq, 1)
})

test('a blank start replaced without an edit stores nothing and lets its lock go', async () => {
    const world = createWorld({ seed: 3 })
    const page = await openPage(world, world.tab('a'))
    let released = 0
    page.flusher.begin({
        id: testId(),
        docId: testId(),
        origin: 'new',
        state: stateOf(goldenChart()),
        label: () => 'Initialize',
        dirty: false,
        done: () => released++,
    })
    begin(page, stateOf(goldenChart()))
    await page.flusher.flush()
    assert.equal(released, 1)
    assert.equal(rows(world, 'sessions').size, 0)
})

test('a replaced session’s pending entries are flushed strictly, then its lock goes', async () => {
    const world = createWorld({ seed: 4 })
    const page = await openPage(world, world.tab('a'))
    let released = 0
    const blank = stateOf(goldenChart())
    const first = page.flusher.begin({
        id: testId(),
        docId: testId(),
        origin: 'new',
        state: blank,
        label: () => 'Initialize',
        dirty: false,
        done: () => released++,
    })
    page.flusher.append('edit', () => 'Changed note', widen(blank), true)
    begin(page, blank, 'import')
    await page.flusher.flush()
    assert.equal(released, 1)
    assert.equal(page.batches[0]?.session.id, first.id)
    assert.equal(page.batches[0]?.durability, 'strict')
    assert.equal(rows(world, 'sessions').size, 2)
    assert.equal(rows(world, 'chains').size, 2)
})

test('an ordinary edit writes one chunk, the nodes above it, a root and an entry', async () => {
    const world = createWorld({ seed: 5 })
    const page = await openPage(world, world.tab('a'))
    let state = sampleState('tests/fixtures/generated-large.json')
    begin(page, state, 'import')
    await page.flusher.flush()
    state = widen(state, 100)
    page.flusher.append('edit', () => 'Changed note', state, true)
    await page.flusher.flush()
    const report = page.reports.at(-1)
    assert.ok(report)
    assert.equal(report.newChunks, 2) // the header, re-encoded every flush, and one slides chunk
    assert.equal(report.stats.chunks, 1) // the header is unchanged, so only the slides chunk is new
    assert.equal(report.stats.entries, 1)
    assert.ok(report.stats.nodes >= 2 && report.stats.nodes <= 3)
    assert.deepEqual(checkStored(world.memory), [])
})

test('a batch sent again after its commit stores nothing twice', async () => {
    const world = createWorld({ seed: 6 })
    const page = await openPage(world, world.tab('a'))
    const state = stateOf(goldenChart())
    begin(page, state)
    page.flusher.append('edit', () => 'Changed note', widen(state), true)
    await page.flusher.flush()
    const [batch] = page.batches
    assert.ok(batch)
    const before = rows(world, 'sessions')
    const result = await page.tab.run(() => page.handlers.flush(batch))
    assert.equal(result.kind, 'stored')
    assert.equal(rows(world, 'entries').size, 2)
    const [session] = rows(world, 'sessions').values()
    const [old] = before.values()
    assert.equal(session?.entryCount, old?.entryCount)
    assert.equal(session?.lastSeq, old?.lastSeq)
    assert.equal(session?.ownBytes, old?.ownBytes)
})

test('row updates are field-level: unknown fields on the session and chain stay', async () => {
    const world = createWorld({ seed: 7 })
    const page = await openPage(world, world.tab('a'))
    let state = stateOf(goldenChart())
    const session = begin(page, state, 'import')
    await page.flusher.flush()
    const other = world.tab('other')
    const otherCore = workerCore(world, other)
    await other.run(() => otherCore.start())
    await other.run(() =>
        otherCore.write(['sessions', 'chains'], async (tx) => {
            const row = (await tx.get('sessions', session.id)) as Record<string, unknown>
            await tx.put('sessions', { ...row, future: 'kept' })
            const chain = (await tx.get('chains', session.chainId)) as Record<string, unknown>
            await tx.put('chains', { ...chain, future: { nested: 1 } })
        }),
    )
    state = widen(state)
    page.flusher.append('edit', () => 'Changed note', state, true)
    await page.flusher.flush()
    assert.equal(rows(world, 'sessions').get(session.id)?.future, 'kept')
    assert.deepEqual(rows(world, 'chains').get(session.chainId)?.future, { nested: 1 })
    assert.equal(rows(world, 'chains').get(session.chainId)?.edited, true)
})

test('an epoch change re-sends only the missing windows, and the memo keeps the rest', async () => {
    const world = createWorld({ seed: 8 })
    const page = await openPage(world, world.tab('a'))
    let state = sampleState('tests/fixtures/generated-large.json')
    begin(page, state, 'import')
    await page.flusher.flush()
    const first = page.batches[0]
    assert.ok(first)

    // Another tab's sweep deletes three chunks the memo holds, and bumps the epoch.
    const lost = first.snapshots[0]?.kinds[0]?.chunks.slice(3, 6) as number[]
    const lostHashes = lost.map(
        (id) => page.results[0]?.kind === 'stored' && page.results[0].chunks[id],
    )
    const sweeper = world.tab('sweeper')
    const sweeperCore = workerCore(world, sweeper)
    await sweeper.run(() => sweeperCore.start())
    await sweeper.run(() =>
        sweeperCore.write(['chunks', 'meta'], async (tx) => {
            for (const hash of lostHashes) await tx.delete('chunks', hashKey(hash as Uint8Array))
            await bumpEpoch(tx)
        }),
    )

    state = widen(state, 1500)
    page.flusher.append('edit', () => 'Changed note', state, true)
    await page.flusher.flush()
    assert.deepEqual(page.errors, [])
    const [missing, resent] = page.results.slice(1)
    assert.equal(missing?.kind, 'missing')
    assert.equal(missing?.kind === 'missing' && missing.chunks.length, 3)
    // The re-sent batch carries the header, the edited window and the three lost ones, no more.
    assert.equal(resent?.kind, 'stored')
    assert.equal(page.batches.at(-1)?.ends.length, 1 + 1 + 3)
    assert.deepEqual(checkStored(world.memory), [])

    // The rest was checked at the new epoch: the next flush checks nothing again.
    state = widen(state, 1501)
    page.flusher.append('edit', () => 'Changed note', state, true)
    await page.flusher.flush()
    assert.equal(page.results.at(-1)?.kind, 'stored')
    assert.equal(page.batches.at(-1)?.ends.length, 2)
})

test('an epoch change with nothing missing re-sends nothing', async () => {
    const world = createWorld({ seed: 9 })
    const page = await openPage(world, world.tab('a'))
    let state = stateOf(goldenChart())
    begin(page, state, 'import')
    await page.flusher.flush()
    const sweeper = world.tab('sweeper')
    const sweeperCore = workerCore(world, sweeper)
    await sweeper.run(() => sweeperCore.start())
    await sweeper.run(() => sweeperCore.write(['meta'], (tx) => bumpEpoch(tx)))
    state = widen(state)
    page.flusher.append('edit', () => 'Changed note', state, true)
    await page.flusher.flush()
    assert.deepEqual(
        page.results.map((result) => result.kind),
        ['stored', 'stored'],
    )
})

test('a session whose chain was continued elsewhere becomes a fork, carrying unknown fields', async () => {
    const world = createWorld({ seed: 10 })
    const forks: string[] = []
    const page = await openPage(world, world.tab('a'), {
        onFork: (session) => forks.push(session.chainId),
    })
    let state = stateOf(goldenChart())
    const session = begin(page, state, 'import')
    await page.flusher.flush()
    const oldChain = session.chainId
    const oldDoc = session.docId

    // Another tab's continuation moved the head (a lost lock, a hung tab).
    const other = world.tab('other')
    const otherCore = workerCore(world, other)
    await other.run(() => otherCore.start())
    await other.run(() =>
        otherCore.write(['sessions', 'chains'], async (tx) => {
            const chain = (await tx.get('chains', oldChain)) as Record<string, unknown>
            await tx.put('sessions', { id: 'continuation', chainId: oldChain })
            await tx.put('chains', {
                ...chain,
                head: 'continuation',
                future: 'carried',
                file: { name: 'coconut.nxsp' },
                edited: true,
            })
        }),
    )

    state = widen(state)
    page.flusher.append('edit', () => 'Changed note', state, true)
    await page.flusher.flush()
    assert.deepEqual(page.errors, [])
    assert.deepEqual(
        page.results.map((result) => result.kind),
        ['stored', 'notHead', 'stored'],
    )
    assert.equal(forks.length, 1)
    assert.notEqual(session.chainId, oldChain)
    assert.notEqual(session.docId, oldDoc)
    const fork = rows(world, 'chains').get(session.chainId)
    assert.ok(fork)
    assert.equal(fork.head, session.id)
    assert.equal(fork.docId, session.docId)
    assert.equal(fork.lineageId, session.lineageId)
    assert.equal(fork.future, 'carried')
    assert.equal(fork.file, undefined)
    // Its own edit marks it edited; the old record's mark isn't copied.
    assert.equal(fork.edited, true)
    assert.equal(fork.hasContent, true)
    assert.equal(rows(world, 'sessions').get(session.id)?.chainId, session.chainId)
    assert.equal(rows(world, 'chains').get(oldChain)?.head, 'continuation')
    assert.deepEqual(checkStored(world.memory), [])
})

test('verify on write: a corrupted deflate fails the flush, puts nothing and pauses storing', async () => {
    const world = createWorld({ seed: 11 })
    const page = await openPage(world, world.tab('a'))
    const state = stateOf(goldenChart())
    begin(page, state, 'import')
    const errors = console.error
    console.error = () => undefined
    setDeflateHookForTests((stored) => {
        const copy = stored.slice()
        copy[0] = (copy[0] ?? 0) ^ 1
        return copy
    })
    try {
        await page.flusher.flush()
    } finally {
        setDeflateHookForTests(undefined)
        console.error = errors
    }
    assert.ok(page.errors.length >= 1)
    assert.equal(page.core.status.reason, 'failed')
    assert.equal(rows(world, 'chunks').size, 0)
    assert.equal(rows(world, 'sessions').size, 0)
    // The entries stayed pending: the next flush stores them, and storing resumes.
    await page.flusher.flush()
    assert.equal(page.core.status.reason, undefined)
    assert.equal(rows(world, 'sessions').size, 1)
    assert.ok(StoragePausedError)
})

test('a worker restart resets the memo and sends every pending entry again', async () => {
    const world = createWorld({ seed: 12 })
    let failNext = false
    const ref: { page?: Page } = {}
    const page = await openPage(world, world.tab('a'), {
        transport: async (batch) => {
            const page = ref.page!
            page.batches.push(batch)
            if (failNext) {
                failNext = false
                const error = new Error('The storage worker restarted')
                error.name = 'WorkerRestartedError'
                throw error
            }
            const result = await page.tab.run(() => page.handlers.flush(batch))
            page.results.push(result)
            return result
        },
    })
    ref.page = page
    let state = stateOf(goldenChart())
    begin(page, state, 'import')
    await page.flusher.flush()
    state = widen(state)
    page.flusher.append('edit', () => 'Changed note', state, true)
    failNext = true
    await page.flusher.flush()
    assert.equal(page.flusher.hasPending, true)
    await page.flusher.restarted()
    assert.equal(page.flusher.hasPending, false)
    // Everything went again: the memo was reset.
    assert.equal(page.batches.at(-1)?.ends.length, page.batches[0]?.ends.length)
    assert.equal(rows(world, 'entries').size, 2)
})

test('entry times are strictly increasing, whatever the clock says', async () => {
    const world = createWorld({ seed: 13 })
    const page = await openPage(world, world.tab('a'), { now: () => 5000 })
    let state = stateOf(goldenChart())
    begin(page, state)
    for (let i = 0; i < 3; i++) {
        state = widen(state, i)
        page.flusher.append('edit', () => 'Changed note', state, true)
    }
    await page.flusher.flush()
    const times = [...rows(world, 'entries').values()].map(({ time }) => time as number)
    assert.equal(times.length, 4)
    for (let i = 1; i < times.length; i++)
        assert.ok((times[i] as number) > (times[i - 1] as number))
})

test('two tabs flushing at once store both sessions whole, under the CI seeds', async () => {
    for (const seed of CI_SEEDS) {
        const world = createWorld({ seed })
        const a = await openPage(world, world.tab('a'))
        const b = await openPage(world, world.tab('b'))
        let stateA = stateOf(goldenChart())
        let stateB = stateOf(goldenChart())
        begin(a, stateA)
        begin(b, stateB)
        for (let i = 0; i < 3; i++) {
            stateA = widen(stateA, i)
            stateB = widen(stateB, i + 1)
            a.flusher.append('edit', () => 'Changed note', stateA, true)
            b.flusher.append('edit', () => 'Changed note', stateB, true)
        }
        await Promise.all([a.flusher.flush(), b.flusher.flush()])
        await world.idle()
        assert.deepEqual([...a.errors, ...b.errors], [], `seed ${seed}`)
        assert.equal(rows(world, 'sessions').size, 2, `seed ${seed}`)
        assert.equal(rows(world, 'entries').size, 8, `seed ${seed}`)
        assert.deepEqual(checkStored(world.memory), [], `seed ${seed}`)
    }
})

test('a kill at every await of two flushes leaves no dangling refs and no half-written session', async () => {
    const base = stateOf(goldenChart())
    const edited = widen(base)
    const again = widen(edited, 3)
    const result = await crashSweep({
        seeds: [undefined, ...CI_SEEDS.slice(0, 2)],
        setup: async (world) => {
            const page = await openPage(world, world.tab('setup'))
            begin(page, base, 'import')
            await page.flusher.flush()
        },
        scenario: async ({ world, victim }) => {
            const page = await openPage(world, victim)
            begin(page, base)
            page.flusher.append('edit', () => 'Changed note', edited, true)
            await page.flusher.flush()
            // A second flush updates the rows the first created.
            page.flusher.append('edit', () => 'Changed note', again, true)
            await page.flusher.flush()
        },
        check: ({ world }) => {
            assert.deepEqual(checkStored(world.memory), [])
            const sessions = [...rows(world, 'sessions').values()]
            const entries = [...rows(world, 'entries').values()]
            assert.equal(rows(world, 'chains').size, sessions.length)
            // Each flush is stored whole or not at all: the session's counters match its entries.
            for (const session of sessions) {
                const own = entries
                    .filter((entry) => entry.sessionId === session.id)
                    .map((entry) => entry.seq as number)
                assert.deepEqual(
                    own,
                    Array.from({ length: own.length }, (_, i) => i + 1),
                )
                assert.equal(session.lastSeq, own.length)
                assert.equal(session.entryCount, own.length)
                if (session.origin === 'new') assert.ok(own.length === 2 || own.length === 3)
            }
        },
    })
    assert.ok(result.every(({ points }) => points > 10))
})
