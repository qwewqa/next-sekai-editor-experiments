import assert from 'node:assert/strict'
import test from 'node:test'
import { equalJson, type JsonValue } from '../../../src/history/operations'
import { DB_NAME } from '../../../src/local/db'
import { FlushOrderError, type FlushSession } from '../../../src/local/flush'
import { toHex } from '../../../src/local/hash'
import { setJournalApplyHookForTests } from '../../../src/local/journal/apply'
import { readJournal, type Journal } from '../../../src/local/journal/format'
import { MemoryStorage, storageJournalStore } from '../../../src/local/journal/store'
import { sessionLock } from '../../../src/local/locks'
import { toRecords } from '../../../src/local/records/records'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import { checkStored, checkStrict } from '../../../src/local/testing/invariants'
import { crashSweep } from '../../../src/local/testing/sweep'
import { CI_SEEDS, createWorld, type World } from '../../../src/local/testing/world'
import type { State } from '../../../src/state'
import { editStep, futureFixtureOperation, nativeOperation } from '../../helpers/historySteps'
import { rows, workerCore } from '../flush/harness'
import { goldenChart, stateOf } from '../records/charts'
import { sampleState } from '../records/samples'
import { replayed, storedStack, widen } from '../timeline/helpers'
import { append, beginSession, openJournalPage, replayAll, replayIn } from './harness'

const same = (a: unknown, b: unknown) => assert(equalJson(a as JsonValue, b as JsonValue))

// Journal replay on the test core (§1.6.4 #7, Step 3b's exit): against a live session, a late
// flush, a missing, deleted or continued session, newer journals, and a damaged key.

const rootOf = (state: State) => toHex(encodeSnapshot(toRecords(state)).root.hash)

const journalOf = (storage: MemoryStorage, sessionId: string) => {
    const text = storage.getItem(`nse.journal.${sessionId}`)
    assert.ok(text, 'a journal was written')
    return JSON.parse(text) as Journal
}

const entriesOf = (world: World, sessionId: string) =>
    [...rows(world, 'entries').values()]
        .filter((row) => row.sessionId === sessionId)
        .sort((a, b) => (a.seq as number) - (b.seq as number))

/** A flushed session with edits after it, killed before they flush: a journal is left. */
const killedAfterEdits = async (seed: number) => {
    const world = createWorld({ seed })
    const page = await openJournalPage(world, 'a')
    // A chart read from level data: every value survives it, so roots match exactly.
    const a = sampleState('tests/fixtures/generated-large.json')
    const session = beginSession(page, a)
    const b = widen(a)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, b)
    await page.flusher.flush()
    const c = widen(b, 1)
    const d = widen(c, 2)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Moved notes')) }, c)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed BPM')) }, d)
    // The hide: the journal, then a flush that never lands.
    assert.equal(page.writer.write(), true)
    return { world, page, session, states: { a, b, c, d } }
}

test('a killed tab’s journal is applied to its session, keeping the committed stack', async () => {
    const { world, page, session, states } = await killedAfterEdits(1)
    const journal = journalOf(page.storage, session.id)
    assert.equal(journal.seq, 4)
    assert.equal(journal.stack.keep, 2)
    same(journal.stack.context.dropped, [editStep(futureFixtureOperation('Moved notes'))])
    assert.equal(journal.stack.head, true)
    same(journal.stack.context.head, editStep(futureFixtureOperation('Changed BPM')))
    assert.equal(journal.descriptor.chainId, session.chainId)

    const { outcomes } = await replayAll(world, page.storage)
    assert.equal(outcomes[0]?.kind, 'applied')
    const entries = entriesOf(world, session.id)
    const recovered = entries.at(-1)
    assert.equal(recovered?.kind, 'recovered')
    assert.equal(recovered?.seq, 4)
    same(
        recovered?.operation,
        nativeOperation({ id: 'nse.recovery', data: { droppedSteps: 1 } }, 'Recovered last change'),
    )
    // The recovered state hashes as the flushed one would: its values survive level data.
    assert.equal(toHex(recovered?.snapshot as Uint8Array), rootOf(states.d))
    assert.equal(rows(world, 'sessions').get(session.id)?.lastSeq, 4)
    // The stored stack equals replay, a recovered entry included.
    const stack = replayed(world, session.id)
    assert.deepEqual(
        stack.slots.map((slot) => toHex(slot.snapshot)),
        [rootOf(states.a), rootOf(states.b), rootOf(states.d)],
    )
    assert.equal(storedStack(world, session.id).window.index, 2)
    assert.deepEqual(checkStored(world.memory), [])
    // The key goes once applied, and a second load replays nothing.
    assert.equal(page.storage.length, 0)
    assert.deepEqual((await replayAll(world, page.storage, 'third')).outcomes, [])
})

test('a journal a flush covered is deleted without an entry: a late flush landed first', async () => {
    const { world, page, session } = await killedAfterEdits(2)
    await page.flusher.flush()
    const before = entriesOf(world, session.id).length
    // That flush was relaxed: the apply's strict commit writes a row before the key goes.
    const strictWhileKept: boolean[] = []
    world.memory.faults.put = (store) => {
        if (store === 'meta') strictWhileKept.push(page.storage.length === 1)
        return undefined
    }
    const { outcomes } = await replayAll(world, page.storage)
    world.memory.faults.put = undefined
    assert.equal(outcomes[0]?.kind, 'covered')
    assert.deepEqual(strictWhileKept, [true])
    assert.equal(entriesOf(world, session.id).length, before)
    assert.equal(page.storage.length, 0)
})

test('a journal of a session open in a live tab is left alone', async () => {
    const { world, page, session } = await killedAfterEdits(3)
    const holder = world.tab('holder')
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    void holder.run(() => holder.locks.request(sessionLock(session.id), {}, () => held))
    await world.idle()
    const { outcomes } = await replayAll(world, page.storage)
    assert.equal(outcomes[0]?.kind, 'live')
    assert.equal(page.storage.length, 1)
    release()
})

test('a session that never flushed is made from the descriptor, with its ids', async () => {
    const world = createWorld({ seed: 4 })
    const page = await openJournalPage(world, 'a')
    const a = stateOf(goldenChart())
    const session = beginSession(page, a, 'new')
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, widen(a))
    page.writer.write()
    const journal = journalOf(page.storage, session.id)
    assert.equal(journal.stack.keep, 0)
    assert.equal(rows(world, 'sessions').size, 0)
    const { outcomes } = await replayAll(world, page.storage)
    assert.equal(outcomes[0]?.kind, 'applied')
    const row = rows(world, 'sessions').get(session.id)
    assert.equal(row?.chainId, session.chainId)
    assert.equal(row?.origin, 'new')
    assert.ok((row?.startedAt as number) <= (row?.updatedAt as number))
    const chain = rows(world, 'chains').get(session.chainId)
    assert.equal(chain?.head, session.id)
    assert.equal(chain?.docId, session.docId)
    assert.equal(chain?.lineageId, session.lineageId)
    assert.equal(chain?.edited, true)
    assert.equal(chain?.hasContent, true)
    assert.equal(entriesOf(world, session.id).length, 1)
    assert.deepEqual(checkStored(world.memory), [])
})

/** Another tab removes the session under storage pressure: its tombstone. */
const tombstone = async (world: World, session: FlushSession) => {
    const other = world.tab('sweeper')
    const core = workerCore(world, other)
    await other.run(() => core.start())
    await other.run(() =>
        core.write(['tombstones'], (tx) =>
            tx.put('tombstones', {
                id: session.id,
                kind: 'session',
                removedAt: 1,
                chainId: session.chainId,
                label: { time: 1, name: '' },
            }),
        ),
    )
}

test('a deleted session’s journal becomes a recovery session in a new chain', async () => {
    const { world, page, session } = await killedAfterEdits(5)
    await tombstone(world, session)
    const { outcomes } = await replayAll(world, page.storage)
    const outcome = outcomes[0]
    assert.equal(outcome?.kind, 'recovery')
    assert.equal(entriesOf(world, session.id).length, 2)
    const result = outcome && 'result' in outcome ? outcome.result : undefined
    assert.equal(result?.kind, 'recovery')
    if (result?.kind !== 'recovery') return
    const chain = rows(world, 'chains').get(result.chainId)
    assert.notEqual(chain?.docId, session.docId)
    assert.equal(chain?.lineageId, session.lineageId)
    assert.equal(chain?.file, undefined)
    assert.equal(rows(world, 'sessions').get(result.sessionId)?.origin, 'journal')
    assert.equal(entriesOf(world, result.sessionId)[0]?.kind, 'recovered')
    assert.equal(page.storage.length, 0)
})

test('a continued session’s journal is never appended to it: a recovery chain', async () => {
    const { world, page, session } = await killedAfterEdits(6)
    const other = world.tab('other')
    const core = workerCore(world, other)
    await other.run(() => core.start())
    await other.run(() =>
        core.write(['chains'], async (tx) => {
            const chain = (await tx.get('chains', session.chainId)) as Record<string, unknown>
            await tx.put('chains', { ...chain, head: 'a-continuation' })
        }),
    )
    const { outcomes } = await replayAll(world, page.storage)
    assert.equal(outcomes[0]?.kind, 'recovery')
    assert.equal(entriesOf(world, session.id).length, 2)
})

/** Rewrites the pending journal's JSON, as a newer build or damage would have left it. */
const rewrite = (
    storage: MemoryStorage,
    sessionId: string,
    change: (journal: Record<string, unknown>) => unknown,
) => {
    const key = `nse.journal.${sessionId}`
    const journal = JSON.parse(storage.getItem(key) ?? '') as Record<string, unknown>
    change(journal)
    storage.setItem(key, JSON.stringify(journal))
}

for (const [name, change] of [
    ['a newer journalVersion', (j: Record<string, unknown>) => (j.journalVersion = 3)],
    ['a higher recordsV', (j: Record<string, unknown>) => (j.recordsV = 2)],
    [
        'a descriptor v of 3',
        (j: Record<string, unknown>) => ((j.descriptor as Record<string, unknown>).v = 3),
    ],
    ['another kind', (j: Record<string, unknown>) => (j.kind = 'headCopy')],
] as const)
    test(`a journal with ${name} is left in place, its session never appended to`, async () => {
        const { world, page, session } = await killedAfterEdits(7)
        rewrite(page.storage, session.id, change)
        const { outcomes } = await replayAll(world, page.storage)
        assert.equal(outcomes[0]?.kind, 'later')
        assert.equal(entriesOf(world, session.id).length, 2)
        assert.equal(page.storage.length, 1)
    })

// Only a newer journal is left for a newer build: a malformed one is not newer, so its
// bytes go to the recovered store (nothing is lost, and nothing waits for a build that won't come).
for (const [name, change] of [
    ['a journalVersion of 0', (j: Record<string, unknown>) => (j.journalVersion = 0)],
    [
        'a journalVersion that is not an integer',
        (j: Record<string, unknown>) => (j.journalVersion = '1'),
    ],
    [
        'a descriptor v of 0',
        (j: Record<string, unknown>) => ((j.descriptor as Record<string, unknown>).v = 0),
    ],
    [
        'a malformed descriptor v',
        (j: Record<string, unknown>) => ((j.descriptor as Record<string, unknown>).v = '1'),
    ],
] as const)
    test(`a journal with ${name} is unreadable, not newer: its bytes are kept`, async () => {
        const { world, page, session } = await killedAfterEdits(7)
        rewrite(page.storage, session.id, change)
        const text = page.storage.getItem(`nse.journal.${session.id}`) ?? ''
        assert.equal(readJournal(text, session.id).kind, 'unreadable')
        const { outcomes } = await replayAll(world, page.storage)
        assert.equal(outcomes[0]?.kind, 'unreadable')
        assert.equal(entriesOf(world, session.id).length, 2)
        const [row] = (world.memory.dump(DB_NAME).get('recovered') ?? []).map(
            (item) => item.value as Record<string, unknown>,
        )
        assert.equal(await (row?.bytes as Blob).text(), text)
        assert.equal(page.storage.length, 0)
    })

// A journal is dropped only after its work is stored: against a session or chain with a session
// of a malformed `v` it becomes one new recovery session holding the journal's head, then the key goes.
for (const where of ['its own session', 'another session of its chain'] as const)
    test(`a journal against ${where} with a malformed v is stored as a recovery session before its key goes`, async () => {
        const { world, page, session, states } = await killedAfterEdits(7)
        const other = world.tab('other')
        const core = workerCore(world, other)
        await other.run(() => core.start())
        await other.run(() =>
            core.write(['sessions'], async (tx) => {
                const row = (await tx.get('sessions', session.id)) as Record<string, unknown>
                if (where === 'its own session') await tx.put('sessions', { ...row, v: 0 })
                else await tx.put('sessions', { ...row, id: 'sibling', v: 0 })
            }),
        )
        const sessionsBefore = new Set(rows(world, 'sessions').keys())
        const entriesBefore = rows(world, 'entries').size
        const { outcomes } = await replayAll(world, page.storage)
        assert.equal(outcomes[0]?.kind, 'recovery', JSON.stringify(outcomes))
        // Exactly one new session, in a new chain, holding a `recovered` entry of the journal's head.
        const added = [...rows(world, 'sessions').values()].filter(
            (row) => !sessionsBefore.has(row.id as string),
        )
        assert.equal(added.length, 1)
        const recovery = added[0]!
        const recoveredEntries = entriesOf(world, recovery.id as string)
        assert.deepEqual(
            recoveredEntries.map((row) => row.kind),
            ['recovered'],
        )
        assert.equal(toHex(recoveredEntries[0]!.snapshot as Uint8Array), rootOf(states.d))
        assert.equal(rows(world, 'entries').size, entriesBefore + 1)
        // The session it could not write into is untouched, and the key went only after the write.
        assert.equal(entriesOf(world, session.id).length, 2)
        assert.equal(page.storage.length, 0)
    })

test('a journal against a session of a newer generation is left in place, with nothing written', async () => {
    const { world, page, session } = await killedAfterEdits(7)
    const other = world.tab('other')
    const core = workerCore(world, other)
    await other.run(() => core.start())
    await other.run(() =>
        core.write(['sessions'], async (tx) => {
            const row = (await tx.get('sessions', session.id)) as Record<string, unknown>
            await tx.put('sessions', { ...row, v: 3 })
        }),
    )
    const before = rows(world, 'sessions').size
    const { outcomes } = await replayAll(world, page.storage)
    assert.equal(outcomes[0]?.kind, 'later')
    assert.equal(rows(world, 'sessions').size, before)
    assert.equal(entriesOf(world, session.id).length, 2)
    assert.equal(page.storage.length, 1)
})

/** Adds an archetype this build doesn't read to the journal's level data. */
const withFutureArchetype = async (journal: Record<string, unknown>) => {
    const { gzip, ungzip } = await import('pako')
    const text = new TextDecoder().decode(
        ungzip(Uint8Array.from(atob(journal.levelDataGz as string), (c) => c.charCodeAt(0))),
    )
    const levelData = JSON.parse(text) as { entities: unknown[] }
    levelData.entities.push({ archetype: 'FutureThing', data: [] })
    const bytes = gzip(JSON.stringify(levelData))
    journal.levelDataGz = btoa(String.fromCharCode(...bytes))
}

test('a newer build’s journal whose level data holds an unknown archetype is left in place', async () => {
    const { world, page, session } = await killedAfterEdits(8)
    const key = `nse.journal.${session.id}`
    const journal = JSON.parse(page.storage.getItem(key) ?? '') as Record<string, unknown>
    await withFutureArchetype(journal)
    journal.appVersion = '0.7.0'
    page.storage.setItem(key, JSON.stringify(journal))
    const { outcomes } = await replayAll(world, page.storage)
    assert.equal(outcomes[0]?.kind, 'later')
    assert.equal(entriesOf(world, session.id).length, 2)
    assert.equal(page.storage.length, 1)
})

test('this build’s own journal whose level data its parser reports keeps its bytes, never left for later', async () => {
    const { world, page, session } = await killedAfterEdits(14)
    const key = `nse.journal.${session.id}`
    const journal = JSON.parse(page.storage.getItem(key) ?? '') as Record<string, unknown>
    await withFutureArchetype(journal)
    const text = JSON.stringify(journal)
    page.storage.setItem(key, text)
    const { outcomes } = await replayAll(world, page.storage)
    assert.equal(outcomes[0]?.kind, 'unreadable')
    const [row] = (world.memory.dump(DB_NAME).get('recovered') ?? []).map(
        (item) => item.value as Record<string, unknown>,
    )
    assert.equal(await (row?.bytes as Blob).text(), text)
    assert.equal(page.storage.length, 0)
})

test('a damaged key’s bytes land in the recovered store, and the key goes', async () => {
    const { world, page, session } = await killedAfterEdits(9)
    const key = `nse.journal.${session.id}`
    const damaged = (page.storage.getItem(key) ?? '').slice(0, 500)
    page.storage.setItem(key, damaged)
    assert.equal(readJournal(damaged, session.id).kind, 'unreadable')
    const { outcomes } = await replayAll(world, page.storage)
    assert.equal(outcomes[0]?.kind, 'unreadable')
    const [row] = (world.memory.dump(DB_NAME).get('recovered') ?? []).map(
        (item) => item.value as Record<string, unknown>,
    )
    assert.equal(row?.source, 'journal')
    assert.equal(row?.from, `journal.${session.id}`)
    assert.equal(row?.sessionId, session.id)
    assert.equal(await (row?.bytes as Blob).text(), damaged)
    assert.equal(page.storage.length, 0)
})

test('replay killed at every await applies the journal once, whole or not at all', async () => {
    const storages = new WeakMap<World, { storage: MemoryStorage; sessionId: string }>()
    const result = await crashSweep({
        seeds: [undefined, ...CI_SEEDS.slice(0, 2)],
        setup: async (world) => {
            const page = await openJournalPage(world, 'setup')
            const a = stateOf(goldenChart())
            const session = beginSession(page, a)
            await page.flusher.flush()
            append(
                page,
                { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) },
                widen(a),
            )
            page.writer.write()
            storages.set(world, { storage: page.storage, sessionId: session.id })
        },
        scenario: async ({ world, victim }) => {
            await replayIn(world, victim, storages.get(world)!.storage)
        },
        recover: async ({ world }) => {
            await replayAll(world, storages.get(world)!.storage, 'recovery')
        },
        check: ({ world }) => {
            const { storage, sessionId } = storages.get(world)!
            assert.deepEqual(checkStrict(world.memory), [])
            assert.deepEqual(
                entriesOf(world, sessionId).map((entry) => entry.kind),
                ['init', 'recovered'],
            )
            assert.equal(storage.length, 0)
        },
    })
    assert.ok(result.every(({ points }) => points > 5))
})

test('an apply that fails by an error that recurs is kept as a recovery session', async () => {
    const { world, page, session } = await killedAfterEdits(10)
    setJournalApplyHookForTests((force) => {
        if (!force) throw new TypeError('A bug in the apply')
    })
    try {
        const { outcomes } = await replayAll(world, page.storage)
        assert.equal(outcomes[0]?.kind, 'recovery')
    } finally {
        setJournalApplyHookForTests(undefined)
    }
    // Nothing of the failed apply was written; the key went with the recovery session.
    assert.equal(entriesOf(world, session.id).length, 2)
    assert.equal(page.storage.length, 0)
    assert.deepEqual(checkStored(world.memory), [])
})

test('a journal that can be neither applied nor kept as a session lands in the recovered store', async () => {
    const { world, page, session } = await killedAfterEdits(11)
    const text = page.storage.getItem(`nse.journal.${session.id}`)
    setJournalApplyHookForTests(() => {
        throw new TypeError('A bug in the apply')
    })
    try {
        const { outcomes } = await replayAll(world, page.storage)
        assert.equal(outcomes[0]?.kind, 'unreadable')
    } finally {
        setJournalApplyHookForTests(undefined)
    }
    const [row] = (world.memory.dump(DB_NAME).get('recovered') ?? []).map(
        (item) => item.value as Record<string, unknown>,
    )
    assert.equal(await (row?.bytes as Blob).text(), text)
    assert.equal(page.storage.length, 0)
    // A second load finds nothing to replay: no journal fails every load.
    assert.deepEqual((await replayAll(world, page.storage, 'third')).outcomes, [])
})

test('an apply that fails because storage does is left for the next load', async () => {
    const { world, page, session } = await killedAfterEdits(12)
    setJournalApplyHookForTests(() => {
        throw new DOMException('The disk failed', 'UnknownError')
    })
    try {
        const { outcomes } = await replayAll(world, page.storage)
        assert.equal(outcomes[0]?.kind, 'failed')
    } finally {
        setJournalApplyHookForTests(undefined)
    }
    assert.equal(page.storage.length, 1)
    assert.equal(entriesOf(world, session.id).length, 2)
    const { outcomes } = await replayAll(world, page.storage, 'later')
    assert.equal(outcomes[0]?.kind, 'applied')
})

test('a flush that lands after replay leaves the replayed stack alone', async () => {
    const { world, page, session, states } = await killedAfterEdits(13)
    const { outcomes } = await replayAll(world, page.storage)
    assert.equal(outcomes[0]?.kind, 'applied')
    // The dead page's flush lands late (§1.6.6), with the entries the journal covered.
    await page.flusher.flush()
    assert.equal(page.results.at(-1)?.kind, 'stored')
    assert.deepEqual(
        entriesOf(world, session.id).map((entry) => entry.kind),
        ['init', 'edit', 'recovered'],
    )
    // The stored stack is still replay's: the dropped slot stays dropped.
    assert.deepEqual(checkStored(world.memory), [])
    const { window, slots } = storedStack(world, session.id)
    assert.deepEqual(
        slots?.map((slot) => toHex(slot.snapshot)),
        [rootOf(states.a), rootOf(states.b), rootOf(states.d)],
    )
    assert.equal(window.index, 2)
})

/** A store whose `remove` does nothing: a kill between replay's commit and the key's delete. */
const killedBeforeRemove = (storage: MemoryStorage) => ({
    store: { ...storageJournalStore(() => storage, 'nse.'), remove: () => undefined },
})

const chainsOf = (world: World) => [...rows(world, 'chains').values()]

test('a kill between a recovery session’s commit and the key’s delete makes no second one', async () => {
    const { world, page, session } = await killedAfterEdits(15)
    await tombstone(world, session)
    const first = await replayIn(
        world,
        world.tab('first'),
        page.storage,
        killedBeforeRemove(page.storage),
    )
    assert.equal(first.outcomes[0]?.kind, 'recovery')
    assert.equal(page.storage.length, 1)
    const chains = chainsOf(world).length
    const kept = first.outcomes[0] && 'result' in first.outcomes[0] && first.outcomes[0].result
    assert.ok(kept && kept.kind === 'recovery')
    const before = {
        chain: rows(world, 'chains').get(kept.chainId),
        session: rows(world, 'sessions').get(kept.sessionId),
    }
    const { outcomes } = await replayAll(world, page.storage)
    assert.equal(outcomes[0]?.kind, 'recovery')
    const [a, b] = [first.outcomes[0], outcomes[0]].map((outcome) =>
        outcome && 'result' in outcome ? outcome.result : undefined,
    )
    assert.deepEqual(
        a?.kind === 'recovery' && [a.sessionId, a.chainId],
        b?.kind === 'recovery' && [b.sessionId, b.chainId],
    )
    assert.equal(chainsOf(world).length, chains)
    // Found, not made again: nothing of it is rewritten (its times included).
    assert.deepEqual(
        {
            chain: rows(world, 'chains').get(kept.chainId),
            session: rows(world, 'sessions').get(kept.sessionId),
        },
        before,
    )
    assert.equal(page.storage.length, 0)
    assert.deepEqual(checkStored(world.memory), [])
})

test('a kill between keeping a damaged key’s bytes and the key’s delete keeps one row', async () => {
    const { world, page, session } = await killedAfterEdits(16)
    const key = `nse.journal.${session.id}`
    page.storage.setItem(key, (page.storage.getItem(key) ?? '').slice(0, 500))
    await replayIn(world, world.tab('first'), page.storage, killedBeforeRemove(page.storage))
    const kept = world.memory.dump(DB_NAME).get('recovered')
    const { outcomes } = await replayAll(world, page.storage)
    assert.equal(outcomes[0]?.kind, 'unreadable')
    // The row is found, not put again (its foundAt included).
    assert.deepEqual(world.memory.dump(DB_NAME).get('recovered'), kept)
    assert.equal(kept?.length, 1)
    assert.equal(page.storage.length, 0)
})

test('a damaged key whose bytes the browser refuses stays, and storing goes on', async () => {
    const { world, page, session } = await killedAfterEdits(17)
    const key = `nse.journal.${session.id}`
    const damaged = (page.storage.getItem(key) ?? '').slice(0, 500)
    page.storage.setItem(key, damaged)
    world.memory.faults.refuseBlobs = true
    const refused = await replayAll(world, page.storage)
    world.memory.faults.refuseBlobs = false
    assert.equal(refused.outcomes[0]?.kind, 'failed')
    assert.deepEqual(refused.core.status, { mode: 'stored' })
    assert.equal(page.storage.getItem(key), damaged)
    // A later load whose database takes Blobs keeps them.
    const { outcomes } = await replayAll(world, page.storage, 'later')
    assert.equal(outcomes[0]?.kind, 'unreadable')
    assert.equal(page.storage.length, 0)
})

test('an apply that fails by a DOMException that recurs is kept as a recovery session', async () => {
    const { world, page, session } = await killedAfterEdits(18)
    setJournalApplyHookForTests((force) => {
        if (!force) throw new DOMException('A bad key', 'DataError')
    })
    try {
        const { outcomes } = await replayAll(world, page.storage)
        assert.equal(outcomes[0]?.kind, 'recovery')
    } finally {
        setJournalApplyHookForTests(undefined)
    }
    assert.equal(entriesOf(world, session.id).length, 2)
    assert.equal(page.storage.length, 0)
})

test('a late flush reaching past a replayed journal leaves no stack that isn’t replay’s', async () => {
    const { world, page, session, states } = await killedAfterEdits(19)
    // One more edit after the journal, never journalled; then the tab dies.
    append(
        page,
        { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) },
        widen(states.d, 3),
    )
    const { outcomes } = await replayAll(world, page.storage)
    assert.equal(outcomes[0]?.kind, 'applied')
    // Its flush lands late: entries up to the journal's are stored already, the last is new.
    await page.flusher.flush()
    // The backstop skipped the entries the recovered entry covers and reported them (A3).
    const [breach, ...rest] = page.errors as FlushOrderError[]
    assert.ok(breach instanceof FlushOrderError && rest.length === 0)
    assert.deepEqual(breach.breach.missing, [])
    assert.ok(breach.breach.covered.length > 0)
    assert.deepEqual(
        entriesOf(world, session.id).map((entry) => entry.kind),
        ['init', 'edit', 'recovered', 'edit'],
    )
    assert.equal(rows(world, 'sessions').get(session.id)?.stack, undefined)
    assert.deepEqual(checkStored(world.memory), [])
})
