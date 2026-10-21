import assert from 'node:assert/strict'
import test from 'node:test'
import { HoleLedger } from '../../../src/local/testing/holes'

// The hole ledger (design A §7, R2-2 and R3-7) on a stand-in flusher, so each way it learns is
// shown alone: the scenario tests in `flush/ownSave.test.ts` run it on the real one.

type Session = { id: string }

const fake = (current?: Session) => {
    const sessions: Session[] = current ? [current] : []
    const deps: { reservedSeq?: (id: string) => number | undefined } = {}
    const flusher = {
        deps,
        current,
        sessions,
        reserveSave: () => ({ session: current ?? { id: 'none' }, seq: 3, wall: 0 }),
        endSave: (_reservation?: unknown, _entry?: unknown) => Promise.resolve(),
        resumeSession: (start: { id: string; lastSeq: number }) => ({
            id: start.id,
            nextSeq: 6,
        }),
        resumeJournalled: (start: { id: string; seq: number }) => ({ id: start.id, nextSeq: 5 }),
    }
    return flusher
}

const watch = (ledger: HoleLedger, flusher: ReturnType<typeof fake>) => {
    ledger.watch(flusher as never)
    return flusher
}

test('a reservation is learned as a hole when it is made', () => {
    const ledger = new HoleLedger()
    const flusher = watch(ledger, fake({ id: 's' }))
    assert.equal(ledger.has('s', 3), false)
    flusher.reserveSave()
    assert.equal(ledger.has('s', 3), true)
    assert.equal(ledger.has('s', 2), false)
    assert.equal(ledger.has('t', 3), false)
})

test('an end that adds the entry makes the seq no hole; an end without one, or on another session, keeps it', async () => {
    const session = { id: 's' }
    const ledger = new HoleLedger()
    const flusher = watch(ledger, fake(session))
    const reservation = flusher.reserveSave()
    await flusher.endSave(reservation as never, { wall: 1 } as never)
    assert.equal(ledger.has('s', 3), false, 'the Save’s entry is added')
    // Learned again by a later marker read, it is still no hole: the entry was added.
    flusher.deps.reservedSeq = () => 3
    ;(flusher.deps.reservedSeq as (id: string) => number | undefined)('s')
    assert.equal(ledger.has('s', 3), false)

    const other = new HoleLedger()
    const bare = watch(other, fake(session))
    await bare.endSave(bare.reserveSave() as never)
    assert.equal(other.has('s', 3), true, 'let go or kept: a hole')
    const gone = new HoleLedger()
    const replaced = watch(gone, fake({ id: 'old' }))
    replaced.sessions.length = 0
    await replaced.endSave(replaced.reserveSave() as never, { wall: 1 } as never)
    assert.equal(gone.has('old', 3), true, 'a session no longer current takes no entry')
})

test('a resume jumps over the seqs between its lastSeq and its next one: each is a hole', () => {
    const ledger = new HoleLedger()
    const flusher = watch(ledger, fake())
    flusher.resumeSession({ id: 's', lastSeq: 2 })
    assert.deepEqual(
        [2, 3, 4, 5, 6].map((seq) => ledger.has('s', seq)),
        [false, true, true, true, false],
    )
    flusher.resumeJournalled({ id: 'j', seq: 2 })
    assert.deepEqual(
        [2, 3, 4, 5].map((seq) => ledger.has('j', seq)),
        [false, true, true, false],
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
