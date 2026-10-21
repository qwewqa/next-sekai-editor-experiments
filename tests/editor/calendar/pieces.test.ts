import fc from 'fast-check'
import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveZone, type Zone } from '../../../src/calendar/calendar'
import {
    daysOf,
    isDivider,
    joinPieces,
    piecesOf,
    type PieceEntry,
} from '../../../src/calendar/pieces'
import { brutePieces } from '../../helpers/piecesBrute'

// I-3's definition: the pieces of a list of entries are its maximal runs of adjacent entries,
// dividers skipped, that share a session and a local day. One definition, the page's and the
// worker's, checked here against a plain restatement over random lists, zones and times.

const HOUR = 3_600_000
const BASE = Date.UTC(2026, 9, 5)

const zones: Zone[] = [
    'UTC',
    'America/New_York',
    'Asia/Kathmandu',
    'Pacific/Kiritimati',
    'Pacific/Pago_Pago',
    'Europe/London',
].map(resolveZone)

const KINDS = ['edit', 'save', 'export', 'continue', 'undo']

/** A time near midnight in some zone, so runs split and merge at day edges. */
const timeArb = fc
    .tuple(fc.integer({ min: 0, max: 6 * 24 }), fc.integer({ min: -2, max: 2 }))
    .map(([hours, half]) => BASE + hours * HOUR + half * 1_800_000)

const entriesArb = (order: 'any' | 'rising') =>
    fc
        .array(
            fc.record({
                session: fc.constantFrom('A', 'B', 'C'),
                time: timeArb,
                kind: fc.constantFrom(...KINDS),
            }),
            { maxLength: 40 },
        )
        .map((list) => {
            const times = list.map((entry) => entry.time)
            if (order === 'rising') times.sort((a, b) => a - b)
            // Oldest first with a rising seq; the list is read newest first.
            return list
                .map((entry, i): PieceEntry => ({
                    sessionId: entry.session,
                    seq: i + 1,
                    time: times[i]!,
                    kind: entry.kind,
                }))
                .reverse()
        })

const zoneArb = fc.constantFrom(...zones)
const kindsArb = fc.option(fc.subarray(['save', 'export', 'edit'], { minLength: 1 }), {
    nil: undefined,
})

for (const order of ['any', 'rising'] as const)
    test(`piecesOf is the brute-force definition: dividers anywhere, times ${order === 'any' ? 'in any order' : 'rising'}`, () => {
        fc.assert(
            fc.property(entriesArb(order), zoneArb, kindsArb, (list, zone, kinds) => {
                assert.deepEqual(piecesOf(list, zone, kinds), brutePieces(list, zone, kinds))
            }),
            { numRuns: 400 },
        )
    })

test('a piece holds no divider and every kept entry once', () => {
    fc.assert(
        fc.property(entriesArb('any'), zoneArb, (list, zone) => {
            const pieces = piecesOf(list, zone)
            const steps = list.filter((entry) => !isDivider(entry.kind))
            assert.equal(
                pieces.reduce((sum, piece) => sum + piece.count, 0),
                steps.length,
            )
            for (const piece of pieces) {
                assert.ok(piece.earliest <= Math.min(piece.oldest, piece.newest))
                assert.ok(piece.latest >= Math.max(piece.oldest, piece.newest))
                assert.ok(piece.oldestSeq <= piece.newestSeq)
            }
        }),
        { numRuns: 200 },
    )
})

test('equal times and a clock set back are runs by adjacency, not by day', () => {
    const zone = resolveZone('UTC')
    const day = (d: number, h = 12) => BASE + d * 24 * HOUR + h * HOUR
    // Newest first: day 1, day 0, day 1 again (a clock set back), all one session.
    const list: PieceEntry[] = [
        { sessionId: 'A', seq: 4, time: day(1), kind: 'edit' },
        { sessionId: 'A', seq: 3, time: day(1), kind: 'edit' },
        { sessionId: 'A', seq: 2, time: day(0), kind: 'edit' },
        { sessionId: 'A', seq: 1, time: day(1), kind: 'edit' },
    ]
    const pieces = piecesOf(list, zone)
    assert.deepEqual(
        pieces.map((piece) => [piece.newestSeq, piece.oldestSeq, piece.count]),
        [
            [4, 3, 2],
            [2, 2, 1],
            [1, 1, 1],
        ],
    )
    assert.equal(daysOf(pieces).length, 3)
})

test('a divider between two entries of one day does not split their piece', () => {
    const zone = resolveZone('UTC')
    const list: PieceEntry[] = [
        { sessionId: 'B', seq: 3, time: BASE + HOUR, kind: 'edit' },
        { sessionId: 'B', seq: 2, time: BASE + 2 * HOUR, kind: 'continue' },
        { sessionId: 'B', seq: 1, time: BASE, kind: 'edit' },
    ]
    assert.deepEqual(
        piecesOf(list, zone).map((piece) => [piece.newestSeq, piece.oldestSeq, piece.count]),
        [[3, 1, 2]],
    )
    // Ranges run from the earliest to the latest time, per piece.
    assert.deepEqual(
        piecesOf(list, zone).map((piece) => [piece.earliest, piece.latest]),
        [[BASE, BASE + HOUR]],
    )
})

test('joinPieces: the pieces of two lists joined are the pieces of the lists joined', () => {
    fc.assert(
        fc.property(entriesArb('any'), zoneArb, kindsArb, fc.nat(40), (list, zone, kinds, cut) => {
            const at = Math.min(cut, list.length)
            const newer = list.slice(0, at)
            const older = list.slice(at)
            const joined = joinPieces(piecesOf(newer, zone, kinds), piecesOf(older, zone, kinds))
            assert.deepEqual(joined, piecesOf(list, zone, kinds))
        }),
        { numRuns: 400 },
    )
})

test('joinPieces leaves its arguments as they were', () => {
    const zone = resolveZone('UTC')
    const newer = piecesOf([{ sessionId: 'A', seq: 2, time: BASE + HOUR, kind: 'edit' }], zone)
    const older = piecesOf([{ sessionId: 'A', seq: 1, time: BASE, kind: 'edit' }], zone)
    const before = JSON.stringify([newer, older])
    assert.equal(joinPieces(newer, older).length, 1)
    assert.equal(JSON.stringify([newer, older]), before)
})

test('daysOf groups adjacent pieces of one day and counts their entries', () => {
    fc.assert(
        fc.property(entriesArb('any'), zoneArb, (list, zone) => {
            const pieces = piecesOf(list, zone)
            const days = daysOf(pieces)
            assert.deepEqual(
                days.flatMap((day) => day.pieces),
                pieces,
            )
            for (const day of days) {
                assert.ok(day.pieces.every((piece) => piece.day === day.day))
                assert.equal(
                    day.count,
                    day.pieces.reduce((sum, piece) => sum + piece.count, 0),
                )
            }
            for (let i = 1; i < days.length; i++) assert.notEqual(days[i]!.day, days[i - 1]!.day)
        }),
        { numRuns: 300 },
    )
})
