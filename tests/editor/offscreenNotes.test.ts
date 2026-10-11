import assert from 'node:assert/strict'
import test from 'node:test'
import {
    combineSelection,
    groupOffscreenNotes,
    hitOffscreenGroup,
    isSameOffscreenGroups,
    offscreenBadgeHitWidth,
    type OffscreenNotePosition,
} from '../../src/editor/offscreenNotes'

const note = (left: number, right: number, y = 100): OffscreenNotePosition<string> => ({
    left,
    right,
    y,
    highlighted: false,
    opacity: 1,
})

test('only fully horizontal offscreen notes in the visible vertical range get indicators', () => {
    const groups = groupOffscreenNotes(
        [
            note(-10, -1),
            note(301, 310),
            note(-5, 5),
            note(295, 305),
            note(-5, 0),
            note(300, 300),
            note(-10, -1, -1),
            note(301, 310, 401),
            note(NaN, -1),
        ],
        300,
        0,
        400,
    )
    assert.deepEqual(
        groups.map(({ side, count }) => [side, count]),
        [
            ['left', 1],
            ['right', 1],
        ],
    )
})

test('nearby offscreen notes aggregate counts and selection without overlapping badges', () => {
    const groups = groupOffscreenNotes(
        [
            ...Array.from({ length: 500 }, () => note(-30, -10, 100)),
            { ...note(-5, -1, 101), highlighted: true, opacity: 0.25 },
            note(310, 320, 100),
            note(-5, -1, 160),
        ],
        300,
        80,
        400,
    )
    assert.equal(groups[0]?.count, 501)
    assert.equal(groups[0]?.highlighted, true)
    assert.equal(groups[0]?.opacity, 1)
    assert.equal(groups[1]?.count, 1)
    assert.ok(Math.abs(groups[0]!.y - groups[2]!.y) >= 28)
    assert.deepEqual(groupOffscreenNotes([note(-5, -1)], 0, 0, 400), [])
    assert.deepEqual(groupOffscreenNotes([note(-5, -1)], 300, 80, 90), [])
})

test('badges collect only their selectable notes', () => {
    const groups = groupOffscreenNotes(
        [
            { ...note(-10, -1, 100), target: 'a' },
            { ...note(-10, -1, 101), opacity: 0.25 },
            { ...note(-10, -1, 102), target: 'b' },
            { ...note(310, 320, 100), opacity: 0.25 },
        ],
        300,
        0,
        400,
    )
    assert.deepEqual(
        groups.map(({ side, count, targets }) => [side, count, targets]),
        [
            ['left', 3, ['a', 'b']],
            ['right', 1, []],
        ],
    )
})

test('badge hit areas cover their slot band out from the edge', () => {
    const groups = groupOffscreenNotes(
        [
            { ...note(-10, -1, 100), target: 'left' },
            { ...note(-10, -1, 160), target: 'lower' },
            ...Array.from({ length: 1000 }, () => ({ ...note(310, 320, 100), target: 'right' })),
            note(310, 320, 300),
        ],
        300,
        0,
        400,
    )
    const left = groups.find((group) => group.targets[0] === 'left')!
    const right = groups.find((group) => group.targets[0] === 'right')!
    assert.equal(hitOffscreenGroup(groups, 2, left.y, 300), left)
    assert.equal(
        hitOffscreenGroup(groups, offscreenBadgeHitWidth(1), left.y + left.spacing / 2 - 0.01, 300),
        left,
    )
    assert.equal(hitOffscreenGroup(groups, offscreenBadgeHitWidth(1) + 1, left.y, 300), undefined)
    assert.equal(hitOffscreenGroup(groups, -1, left.y, 300), undefined)
    assert.notEqual(hitOffscreenGroup(groups, 2, left.y + left.spacing / 2 + 1, 300), left)
    // Wider counts get a wider reach.
    assert.equal(offscreenBadgeHitWidth(1000), 68)
    assert.equal(hitOffscreenGroup(groups, 300 - 68, right.y, 300), right)
    assert.equal(hitOffscreenGroup(groups, 301, right.y, 300), undefined)
    // Badges without selectable notes are not hit.
    assert.equal(hitOffscreenGroup(groups, 298, 300, 300), undefined)
})

test('ctrl toggles badge notes into or out of the selection', () => {
    assert.deepEqual(combineSelection(['a', 'b'], ['c'], false), ['c'])
    assert.deepEqual(combineSelection(['a', 'b'], ['b', 'c'], true), ['a', 'b', 'c'])
    assert.deepEqual(combineSelection(['a', 'b', 'c'], ['b', 'c'], true), ['a'])
    assert.deepEqual(combineSelection(['a'], [], true), ['a'])
})

test('an inset keeps badges clear of the edges and counts the notes there', () => {
    const groups = groupOffscreenNotes(
        [note(-10, -1, 0), note(-10, -1, 10), note(-10, -1, 200), note(-10, -1, 395)],
        300,
        0,
        400,
        24,
    )
    // The whole 28 px slots between the insets at 24 and 376: from 28 to 364.
    assert.deepEqual(
        groups.map(({ slot, count, y }) => [slot, count, y]),
        [
            [1, 2, 42],
            [7, 1, 210],
            [12, 1, 350],
        ],
    )
    assert.ok(groups.every(({ y, spacing }) => y - spacing / 2 >= 24 && y + spacing / 2 <= 376))
})

test('groupings compare equal only with the same badges and targets', () => {
    const target = (y: number, value?: string) => ({ ...note(-10, -1, y), target: value })
    const group = (notes: OffscreenNotePosition<string>[]) =>
        groupOffscreenNotes(notes, 300, 0, 400)
    const base = group([target(100, 'a'), target(110, 'b'), note(301, 310, 300)])
    assert.ok(
        !isSameOffscreenGroups(
            base,
            group([target(105, 'b'), target(100, 'a'), note(320, 330, 310)]),
        ),
    )
    assert.ok(
        isSameOffscreenGroups(
            base,
            group([target(105, 'a'), target(108, 'b'), note(320, 330, 305)]),
        ),
    )
    assert.ok(
        !isSameOffscreenGroups(base, group([target(100, 'a'), target(110), note(301, 310, 300)])),
    )
    assert.ok(
        !isSameOffscreenGroups(
            base,
            group([target(100, 'a'), target(110, 'c'), note(301, 310, 300)]),
        ),
    )
    assert.ok(!isSameOffscreenGroups(base, group([target(100, 'a'), note(301, 310, 300)])))
    assert.ok(!isSameOffscreenGroups(base, group([target(100, 'a'), target(110, 'b')])))
    assert.ok(
        !isSameOffscreenGroups(
            base,
            group([target(100, 'a'), target(200, 'b'), note(301, 310, 300)]),
        ),
    )
    assert.ok(
        !isSameOffscreenGroups(
            base,
            group([
                { ...target(100, 'a'), highlighted: true },
                target(110, 'b'),
                note(301, 310, 300),
            ]),
        ),
    )
    assert.ok(
        !isSameOffscreenGroups(
            base,
            group([
                { ...target(100, 'a'), opacity: 0.5 },
                { ...target(110, 'b'), opacity: 0.5 },
                note(301, 310, 300),
            ]),
        ),
    )
    // Slots anchored elsewhere split the notes.
    assert.ok(
        !isSameOffscreenGroups(
            base,
            groupOffscreenNotes(
                [target(100, 'a'), target(110, 'b'), note(301, 310, 300)],
                300,
                0,
                400,
                0,
                20,
            ),
        ),
    )
})

test('no badge reaches further in than the widest possible count', () => {
    // The hover path skips badge lookups beyond this reach.
    const reach = offscreenBadgeHitWidth(Number.MAX_SAFE_INTEGER)
    for (let count = 1; count < Number.MAX_SAFE_INTEGER; count *= 7)
        assert.ok(offscreenBadgeHitWidth(count) <= reach)
})

test('badges scroll with their notes, changing only at the edges', () => {
    const notes = [60, 65, 200, 300, 370].map((y, index) => ({
        ...note(-10, -1, y),
        target: String(index),
    }))
    // Notes and anchor scrolled down by a number of px.
    const show = (scroll: number) =>
        groupOffscreenNotes(
            notes.map((item) => ({ ...item, y: item.y + scroll })),
            300,
            0,
            400,
            24,
            scroll,
        )
    const base = show(0)
    assert.deepEqual(
        base.map(({ count, y }) => [count, y]),
        [
            [2, 70],
            [1, 210],
            [1, 294],
            // 370 is in the slot the inset cuts, so it counts in the last whole one.
            [1, 350],
        ],
    )
    // Positions are from the anchor, so scrolling within whole slots keeps the same badges.
    for (const scroll of [0.5, 3, -2.25]) assert.ok(isSameOffscreenGroups(base, show(scroll)))
    // The bottom slot is cut once scrolled 20 px down; its note joins the slot above.
    assert.deepEqual(
        show(20).map(({ count, y }) => [count, y + 20]),
        [
            [2, 90],
            [1, 230],
            [1, 314],
            [1, 342],
        ],
    )
    // Scrolled 40 px up, the top notes are in the inset and count in the first whole slot.
    assert.deepEqual(
        show(-40).map(({ count, y }) => [count, y - 40]),
        [
            [2, 58],
            [1, 170],
            [1, 254],
            [1, 338],
        ],
    )
})

test('a band too short for two slots keeps one badge fixed to the pane', () => {
    for (const scroll of [0, 7, 19]) {
        const [badge] = groupOffscreenNotes([note(-10, -1, 40 + scroll)], 300, 0, 100, 24, scroll)
        assert.equal(badge!.y + scroll, 50)
        assert.equal(badge!.spacing, 52)
    }
})
