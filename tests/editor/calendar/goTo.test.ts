import fc from 'fast-check'
import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveZone, type Zone } from '../../../src/calendar/calendar'
import { composeGoTo } from '../../../src/calendar/goTo'
import { piecesOf, type PieceEntry } from '../../../src/calendar/pieces'
import { brutePieces } from '../../helpers/piecesBrute'

// Spec-C invariant 11: Go To's pieces are the index's pieces with the open session's listed
// entries above what the index covers joined on top, so they equal the pieces of the whole list.
// Checked against `piecesOf` (and the plain restatement) over random lists, zones and covers.

const HOUR = 3_600_000
const BASE = Date.UTC(2026, 9, 5)
const OPEN = 'open'
const PARENT = 'parent'
const KINDS = ['edit', 'save', 'export', 'continue']

const zones: Zone[] = ['UTC', 'America/New_York', 'Pacific/Kiritimati'].map(resolveZone)

const entryArb = fc.record({
    time: fc.integer({ min: 0, max: 4 * 24 }).map((hours) => BASE + hours * HOUR),
    kind: fc.constantFrom(...KINDS),
})

/** The open session's entries and its parent's, newest first, each with a `seq`. */
const chainArb = fc
    .tuple(fc.array(entryArb, { maxLength: 20 }), fc.array(entryArb, { maxLength: 20 }))
    .map(([own, parent]) => {
        const make = (list: typeof own, sessionId: string): PieceEntry[] =>
            list.map((entry, i) => ({ sessionId, seq: i + 1, ...entry })).reverse()
        return { open: make(own, OPEN), parent: make(parent, PARENT) }
    })

test('an index that stops at any stored entry, with the rest listed, equals the pieces of the whole list', () => {
    fc.assert(
        fc.property(
            chainArb,
            fc.nat(20),
            fc.constantFrom(...zones),
            fc.option(fc.constant(['save', 'export']), { nil: undefined }),
            (chain, cut, zone, kinds) => {
                const top = Math.min(cut, chain.open.length)
                const covered = chain.open.filter((entry) => entry.seq <= top)
                const index = {
                    pieces: piecesOf([...covered, ...chain.parent], zone, kinds),
                    top: top || undefined,
                    topSession: OPEN,
                    zone,
                }
                const whole = [...chain.open, ...chain.parent]
                const expected = piecesOf(whole, zone, kinds)
                assert.deepEqual(expected, brutePieces(whole, zone, kinds))
                // The list holds the stored entries too, as the Timeline's does, in any order.
                assert.deepEqual(composeGoTo(chain.open, index, OPEN, kinds), expected)
                assert.deepEqual(
                    composeGoTo([...chain.open].reverse(), index, OPEN, kinds),
                    expected,
                )
            },
        ),
    )
})

test('an index read for the parent (the open session is not stored) gets every listed entry', () => {
    fc.assert(
        fc.property(chainArb, fc.constantFrom(...zones), (chain, zone) => {
            const index = {
                pieces: piecesOf(chain.parent, zone),
                top: chain.parent[0]?.seq,
                topSession: PARENT,
                zone,
            }
            assert.deepEqual(
                composeGoTo(chain.open, index, OPEN),
                piecesOf([...chain.open, ...chain.parent], zone),
            )
        }),
    )
})

test("an entry both stored and waiting is counted once; other sessions' entries are not added", () => {
    const zone = resolveZone('UTC')
    const at = (seq: number, sessionId = OPEN, kind = 'edit'): PieceEntry => ({
        sessionId,
        seq,
        time: BASE + seq * 60_000,
        kind,
    })
    const index = { pieces: piecesOf([at(2), at(1)], zone), top: 2, topSession: OPEN, zone }
    const listed = [at(4), at(3), at(3), at(2), at(9, 'elsewhere')]
    const [piece, ...rest] = composeGoTo(listed, index, OPEN)
    assert.equal(rest.length, 0)
    assert.equal(piece?.count, 4)
    assert.equal(piece?.newestSeq, 4)
})

test('a clock set back counts by seq: the entries stay, and each day has its own count', () => {
    const zone = resolveZone('UTC')
    const day = (d: number, seq: number): PieceEntry => ({
        sessionId: OPEN,
        seq,
        time: BASE + d * 24 * HOUR,
        kind: 'edit',
    })
    const index = { pieces: piecesOf([day(2, 2), day(2, 1)], zone), top: 2, topSession: OPEN, zone }
    const pieces = composeGoTo([day(1, 4), day(3, 3)], index, OPEN)
    assert.deepEqual(
        pieces.map((piece) => [piece.newestSeq, piece.count]),
        [
            [4, 1],
            [3, 1],
            [2, 2],
        ],
    )
})
