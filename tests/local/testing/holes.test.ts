import assert from 'node:assert/strict'
import test from 'node:test'
import { HoleLedger } from '../../../src/local/testing/holes'

// The hole ledger on a stand-in flusher, so each way it learns is
// shown alone: the scenario tests in `flush/ownSave.test.ts` run it on the real one. The stand-in
// numbers as the real one does: a resume goes on from `max(lastSeq, marker) + 1`, and a
// journal-only resume numbers its `recovered` entry itself, after the marker.

type Session = { id: string; pending: { seq: number; kind?: string }[] }

const fake = (current?: Session) => {
    const sessions: Session[] = current ? [current] : []
    const deps: { reservedSeq?: (id: string) => number | undefined } = {}
    const marker = (id: string) => deps.reservedSeq?.(id) ?? 0
    const flusher = {
        deps,
        current,
        sessions,
        reserveSave: () => ({ session: current ?? { id: 'none', pending: [] }, seq: 3, wall: 0 }),
        // As the real one reports: the entry is added only to a session still in `sessions`.
        endSave: (
            reservation?: { session: Session },
            entry?: unknown,
            _identity?: unknown,
            keep?: boolean,
        ) => {
            if (entry && sessions.includes(reservation!.session))
                reservation!.session.pending.push({ seq: 3, kind: 'save' } as never)
            return Promise.resolve(
                entry
                    ? sessions.includes(reservation!.session)
                        ? 'added'
                        : 'notCurrent'
                    : keep
                      ? 'kept'
                      : 'letGo',
            )
        },
        resumeSession: (start: { id: string; lastSeq: number }) => ({
            id: start.id,
            nextSeq: Math.max(start.lastSeq, marker(start.id)) + 1,
        }),
        // The entry takes the first `seq` after the marker; `nextSeq` is past it.
        resumeJournalled: (start: { id: string; seq: number }) => ({
            id: start.id,
            nextSeq: Math.max(start.seq, marker(start.id)) + 2,
        }),
    }
    return flusher
}

const watch = (ledger: HoleLedger, flusher: ReturnType<typeof fake>) => {
    ledger.watch(flusher as never)
    return flusher
}

const session = (id: string): Session => ({ id, pending: [] })

test('a reservation is learned as a hole when it is made', () => {
    const ledger = new HoleLedger()
    const flusher = watch(ledger, fake(session('s')))
    assert.equal(ledger.has('s', 3), false)
    flusher.reserveSave()
    assert.equal(ledger.has('s', 3), true)
    assert.equal(ledger.has('s', 2), false)
    assert.equal(ledger.has('t', 3), false)
})

test('an end that adds the entry makes the seq no hole; an end without one, or on another session, keeps it', async () => {
    const current = session('s')
    const ledger = new HoleLedger()
    const flusher = watch(ledger, fake(current))
    const reservation = flusher.reserveSave()
    const ended = flusher.endSave(reservation as never, { wall: 1 } as never)
    assert.equal(ledger.has('s', 3), false, 'no hole while the end’s flush runs')
    assert.equal(await ended, 'added')
    assert.equal(ledger.has('s', 3), false, 'the Save’s entry is added')
    // Learned again by a later marker read, it is still no hole: the entry was added.
    flusher.deps.reservedSeq = () => 3
    ;(flusher.deps.reservedSeq as (id: string) => number | undefined)('s')
    assert.equal(ledger.has('s', 3), false)

    current.pending.length = 0
    const other = new HoleLedger()
    const bare = watch(other, fake(current))
    assert.equal(await bare.endSave(bare.reserveSave() as never), 'letGo')
    assert.equal(other.has('s', 3), true, 'let go or kept: a hole')
    const gone = new HoleLedger()
    const replaced = watch(gone, fake(session('old')))
    replaced.sessions.length = 0
    assert.equal(
        await replaced.endSave(replaced.reserveSave() as never, { wall: 1 } as never),
        'notCurrent',
    )
    assert.equal(gone.has('old', 3), true, 'a session no longer current takes no entry')
})

test('a resume jumps over the seqs between its lastSeq and the marker: each is a hole, and no more', () => {
    const ledger = new HoleLedger()
    const flusher = watch(ledger, fake())
    flusher.deps.reservedSeq = (id) => (id === 's' ? 5 : id === 'j' ? 4 : undefined)
    flusher.resumeSession({ id: 's', lastSeq: 2 })
    assert.deepEqual(
        [2, 3, 4, 5, 6].map((seq) => ledger.has('s', seq)),
        [false, true, true, true, false],
    )
    // A journal-only resume numbers its own `recovered` entry after the marker: no hole, since
    // that entry is the journal's only copy of its edits.
    const journalled = flusher.resumeJournalled({ id: 'j', seq: 2 })
    assert.equal(journalled.nextSeq, 6, 'the entry takes 5')
    assert.deepEqual(
        [2, 3, 4, 5].map((seq) => ledger.has('j', seq)),
        [false, true, true, false],
    )
    // With no marker there is no jump.
    flusher.resumeSession({ id: 'n', lastSeq: 2 })
    flusher.resumeJournalled({ id: 'm', seq: 2 })
    assert.deepEqual(
        [3, 4].map((seq) => [ledger.has('n', seq), ledger.has('m', seq)]),
        [
            [false, false],
            [false, false],
        ],
    )
})

test('a marker a resume reads is learned, and a deps hook set later is wrapped', () => {
    const ledger = new HoleLedger()
    const flusher = watch(ledger, fake())
    assert.equal(flusher.deps.reservedSeq, undefined)
    flusher.deps.reservedSeq = (id) => (id === 's' ? 7 : undefined)
    const read = flusher.deps.reservedSeq as (id: string) => number | undefined
    assert.equal(read('s'), 7)
    assert.equal(read('t'), undefined)
    assert.equal(ledger.has('s', 7), true)
    assert.equal(ledger.has('t', 7), false)
})

test('a seq a commit created a row at is no hole, until a power loss undoes that commit', () => {
    const ledger = new HoleLedger()
    ledger.learn('s', 4)
    assert.equal(ledger.has('s', 4), true)
    ledger.created('s', 4)
    assert.equal(ledger.has('s', 4), false, 'a row that vanished is a loss, not a hole')
    ledger.undone('s', 4)
    assert.equal(ledger.has('s', 4), true, 'a power loss took the row back')
})
