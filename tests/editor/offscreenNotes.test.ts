import assert from 'node:assert/strict'
import test from 'node:test'
import {
    combineSelection,
    groupOffscreenNotes,
    hitOffscreenGroup,
    isSameOffscreenGroups,
    offscreenBadgeHitWidth,
    type OffscreenNoteGroup,
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
    // Slots within a badge of the edges, at 38 and 362 between the insets, are held there.
    assert.deepEqual(
        groups.map(({ slot, count, y, fixed }) => [slot, count, y, fixed]),
        [
            [-Infinity, 2, 38, true],
            [7, 1, 210, false],
            [Infinity, 1, 362, true],
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
                [target(80, 'a'), target(90, 'b'), note(301, 310, 280)],
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

// Pane y of each badge, count and whether it's held at an edge.
const drawn = (groups: OffscreenNoteGroup<string>[], anchor: number) =>
    groups.map(({ y, fixed, count }) => [fixed ? y : anchor + y, count, fixed] as const)

test('badges scroll with their notes, changing only at the edges', () => {
    const notes = [60, 65, 200, 300, 370].map((y, index) => ({
        ...note(-10, -1, y),
        target: String(index),
    }))
    // Anchor scrolled down by a number of px; note positions are from it.
    const show = (scroll: number) => groupOffscreenNotes(notes, 300, 0, 400, 24, scroll)
    const base = show(0)
    assert.deepEqual(drawn(base, 0), [
        [70, 2, false],
        [210, 1, false],
        [294, 1, false],
        // 370's slot would overlap a badge at the bottom edge, so it is held there.
        [362, 1, true],
    ])
    // Scrolling within whole slots keeps the same badges.
    for (const scroll of [0.5, 3, -2.25]) assert.ok(isSameOffscreenGroups(base, show(scroll)))
    assert.deepEqual(drawn(show(20), 20), [
        [90, 2, false],
        [230, 1, false],
        [314, 1, false],
        [362, 1, true],
    ])
    // Scrolled 40 px up, the top notes are in the inset, held at the top edge.
    assert.deepEqual(drawn(show(-40), -40), [
        [38, 2, true],
        [170, 1, false],
        [254, 1, false],
        [338, 1, false],
    ])
})

test('a lone badge moves only with the scroll across an edge, hopping once to it', () => {
    for (const edge of ['top', 'bottom'] as const)
        for (const entering of [false, true]) {
            // The note's pane y, 1.5 px a step from 200 px inside to past the edge, or back.
            const outside = edge === 'top' ? -5 : 405
            const from = entering ? outside : 200
            const to = entering ? 200 : outside
            const direction = Math.sign(to - from)
            let previous: number | undefined
            let shown = 0
            let hops = 0
            for (let i = 0; i <= Math.abs(to - from) / 1.5; i++) {
                const y = from + direction * i * 1.5
                // Note 100 px from the anchor.
                const groups = groupOffscreenNotes([note(-10, -1, 100)], 300, 0, 400, 24, y - 100)
                const badge = drawn(groups, y - 100)[0]
                assert.equal(!!badge, y >= 0 && y <= 400, `step ${i}`)
                if (!badge) continue
                shown++
                // Within the band, and never moving against the scroll.
                assert.ok(badge[0] >= 38 && badge[0] <= 362, `step ${i}`)
                if (previous !== undefined) {
                    const move = (badge[0] - previous) * direction
                    assert.ok(move >= 0 && move <= 24 + 1.5, `step ${i}: ${move}`)
                    if (move > 1.5) hops++
                }
                previous = badge[0]
            }
            assert.ok(shown > 100)
            assert.equal(hops, 1, `${edge} ${entering}`)
        }
})

test('slots within a badge of an edge are held there', () => {
    // Notes 10 and 40 px from the anchor, scrolled up past the top edge.
    const show = (anchor: number, ys = [10, 40]) =>
        drawn(
            groupOffscreenNotes(
                ys.map((y) => ({ ...note(-10, -1, y), target: String(y) })),
                300,
                0,
                400,
                24,
                anchor,
            ),
            anchor,
        )
    assert.deepEqual(show(48), [
        [62, 1, false],
        [90, 1, false],
    ])
    assert.deepEqual(show(47), [
        [38, 1, true],
        [89, 1, false],
    ])
    // 24 px from the edge badge: about to overlap it.
    assert.deepEqual(show(20), [
        [38, 1, true],
        [62, 1, false],
    ])
    assert.deepEqual(show(19), [[38, 2, true]])
    assert.deepEqual(show(-10), [[38, 2, true]])
    assert.deepEqual(show(-11), [[38, 1, true]])
    assert.deepEqual(show(-40), [[38, 1, true]])
    assert.deepEqual(show(-41), [])
    // Alone too, so its badge doesn't depend on other notes coming and going.
    assert.deepEqual(show(20, [40]), [[62, 1, false]])
    assert.deepEqual(show(19, [40]), [[38, 1, true]])
    // Hit tests use the drawn positions, the nearer badge where their bands meet.
    const groups = groupOffscreenNotes(
        [
            { ...note(-10, -1, 10), target: 'a' },
            { ...note(-10, -1, 40), target: 'b' },
        ],
        300,
        0,
        400,
        24,
        21,
    )
    assert.deepEqual(drawn(groups, 21), [
        [38, 1, true],
        [63, 1, false],
    ])
    const hit = (y: number) => hitOffscreenGroup(groups, 2, y, 300, 21)?.targets[0]
    assert.equal(hit(24), 'a')
    assert.equal(hit(50), 'a')
    assert.equal(hit(51), 'b')
    assert.equal(hit(77), 'b')
    assert.equal(hit(78), undefined)
})

test('a whole slot that both edge badges would overlap goes to the nearer one', () => {
    // Band 24 to 94: with the anchor at 44 or 46, the only whole slot is 0, centred at 58 or 60.
    const show = (anchor: number) =>
        drawn(
            groupOffscreenNotes(
                [note(-10, -1, -30), note(-10, -1, 10), note(-10, -1, 60)],
                300,
                0,
                118,
                24,
                anchor,
            ),
            anchor,
        )
    assert.deepEqual(show(44), [
        [38, 2, true],
        [80, 1, true],
    ])
    assert.deepEqual(show(46), [
        [38, 1, true],
        [80, 2, true],
    ])
})

test('a band too short for two slots keeps one badge fixed to the pane', () => {
    for (const scroll of [0, 7, 19]) {
        const [badge] = groupOffscreenNotes([note(-10, -1, 40)], 300, 0, 100, 24, scroll)
        assert.equal(badge!.fixed, true)
        assert.equal(badge!.y, 50)
        assert.equal(badge!.spacing, 52)
    }
})

test('a note on a slot boundary stays in its slot wherever the anchor is', () => {
    // Elevation 0 sits exactly on the anchor, which rounding to device pixels makes fractional.
    for (let anchor = 300; anchor < 330; anchor += 0.8 * 0.137) {
        const [badge] = groupOffscreenNotes([note(-10, -1, -0)], 300, 0, 1000, 0, anchor)
        assert.ok(badge!.slot === 0 && badge!.y === 14)
    }
})
