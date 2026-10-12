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
            // Their slots are past the edges.
            note(-10, -1, -30),
            note(301, 310, 430),
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
    // Scrolled 40 px up, the top notes are held at the top; 370's slot is still in the bottom hold.
    assert.deepEqual(drawn(show(-40), -40), [
        [38, 2, true],
        [170, 1, false],
        [254, 1, false],
        [362, 1, true],
    ])
})

test('a lone badge moves only with the scroll across an edge, hopping once to it', () => {
    for (const edge of ['top', 'bottom'] as const)
        for (const entering of [false, true]) {
            // The note's pane y, 1.5 px a step from 200 px inside to past the edge, or back.
            const outside = edge === 'top' ? -60 : 460
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
                // Shown in the pane, and until its slot leaves it.
                if (y >= 0 && y <= 400) assert.ok(badge, `step ${i}`)
                if (y < -2 * 28 || y > 400 + 2 * 28) assert.ok(!badge, `step ${i}`)
                if (!badge) continue
                shown++
                // Within the band, and never moving against the scroll.
                assert.ok(badge[0] >= 38 && badge[0] <= 362, `step ${i}`)
                if (previous !== undefined) {
                    const move = (badge[0] - previous) * direction
                    assert.ok(move >= 0 && move <= 28 + 1.5, `step ${i}: ${move}`)
                    if (move > 1.5) hops++
                }
                previous = badge[0]
            }
            assert.ok(shown > 100)
            assert.equal(hops, 1, `${edge} ${entering}`)
        }
})

test('slots within a slot of an edge are held there', () => {
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
    assert.deepEqual(show(52), [
        [66, 1, false],
        [94, 1, false],
    ])
    assert.deepEqual(show(51), [
        [38, 1, true],
        [93, 1, false],
    ])
    // A slot from the edge badge, 4 px clear of it like any two badges.
    assert.deepEqual(show(24), [
        [38, 1, true],
        [66, 1, false],
    ])
    assert.deepEqual(show(23), [[38, 2, true]])
    // Each counts until its slot leaves the pane.
    assert.deepEqual(show(-32), [[38, 2, true]])
    assert.deepEqual(show(-33), [[38, 1, true]])
    assert.deepEqual(show(-60), [[38, 1, true]])
    assert.deepEqual(show(-61), [])
    // Alone too, so its badge doesn't depend on other notes coming and going.
    assert.deepEqual(show(24, [40]), [[66, 1, false]])
    assert.deepEqual(show(23, [40]), [[38, 1, true]])
})

test('a held badge stays as one note leaves past the edge and the next is held', () => {
    // Three slots apart: as the first one's slot leaves the pane, the next one is held, at the same anchor.
    const show = (anchor: number) =>
        drawn(
            groupOffscreenNotes([note(-10, -1, 10), note(-10, -1, 94)], 300, 0, 400, 24, anchor),
            anchor,
        )
    assert.deepEqual(show(-32), [
        [38, 1, true],
        [66, 1, false],
    ])
    assert.deepEqual(show(-32.5), [[38, 1, true]])
    // Notes up to three slots apart keep a badge held at each edge (main pane holds 3 slots, EE 2).
    for (const [top, inset, spacings] of [
        [0, 24, [50, 70, 84]],
        [84, 0, [30, 50, 56]],
    ] as const)
        for (const spacing of spacings)
            for (let anchor = -1000; anchor < 1000; anchor += 0.37) {
                const ys = Array.from({ length: 40 }, (_, index) => index * spacing)
                const groups = groupOffscreenNotes(
                    ys.map((y) => note(-10, -1, y)),
                    300,
                    top,
                    400,
                    inset,
                    anchor,
                )
                const held = (slot: number) => groups.some((group) => group.slot === slot)
                // With notes on both sides of the hold.
                if (anchor < top - spacing && anchor + ys.at(-1)! > 200)
                    assert.ok(held(-Infinity), `${top} ${spacing} ${anchor}`)
                if (anchor + ys.at(-1)! > 400 + spacing && anchor < 200)
                    assert.ok(held(Infinity), `${top} ${spacing} ${anchor}`)
            }
})

test('hit areas run from a held badge to the next badge, each point hitting the nearer', () => {
    // 10 is held at the top and 40 rides at 72, in the slot next to the held ones: they meet halfway.
    const groups = groupOffscreenNotes(
        [
            { ...note(-10, -1, 10), target: 'a' },
            { ...note(-10, -1, 40), target: 'b' },
        ],
        300,
        0,
        400,
        24,
        30,
    )
    assert.deepEqual(drawn(groups, 30), [
        [38, 1, true],
        [72, 1, false],
    ])
    const hit = (y: number) => hitOffscreenGroup(groups, 2, y, 300, 30)?.targets[0]
    assert.equal(hit(23.5), undefined)
    for (let y = 24; y < 55; y += 0.5) assert.equal(hit(y), 'a', `${y}`)
    for (let y = 55.5; y <= 86; y += 0.5) assert.equal(hit(y), 'b', `${y}`)
    assert.equal(hit(86.5), undefined)
    // A slot further, the empty slot between them is left out.
    const apart = groupOffscreenNotes(
        [
            { ...note(-10, -1, 10), target: 'a' },
            { ...note(-10, -1, 70), target: 'b' },
        ],
        300,
        0,
        400,
        24,
        30,
    )
    assert.deepEqual(drawn(apart, 30), [
        [38, 1, true],
        [100, 1, false],
    ])
    const hitApart = (y: number) => hitOffscreenGroup(apart, 2, y, 300, 30)?.targets[0]
    for (let y = 24; y <= 58; y += 0.5) assert.equal(hitApart(y), 'a', `${y}`)
    for (let y = 58.5; y < 86; y += 0.5) assert.equal(hitApart(y), undefined, `${y}`)
    for (let y = 86; y <= 114; y += 0.5) assert.equal(hitApart(y), 'b', `${y}`)
    // At the bottom too: 310 is held and 290 rides at 324.
    const bottom = groupOffscreenNotes(
        [
            { ...note(-10, -1, 310), target: 'c' },
            { ...note(-10, -1, 290), target: 'd' },
        ],
        300,
        0,
        400,
        24,
        30,
    )
    assert.deepEqual(drawn(bottom, 30), [
        [362, 1, true],
        [324, 1, false],
    ])
    const hitBottom = (y: number) => hitOffscreenGroup(bottom, 2, y, 300, 30)?.targets[0]
    assert.equal(hitBottom(309.5), undefined)
    for (let y = 310; y < 343; y += 0.5) assert.equal(hitBottom(y), 'd', `${y}`)
    for (let y = 343.5; y <= 376; y += 0.5) assert.equal(hitBottom(y), 'c', `${y}`)
    assert.equal(hitBottom(376.5), undefined)
})

test('a dimmed badge keeps its hit area from a neighbour', () => {
    const group = (y: number, targets: string[]): OffscreenNoteGroup<string> => ({
        side: 'left',
        slot: y,
        fixed: false,
        y,
        spacing: 28,
        count: 1,
        highlighted: false,
        opacity: 1,
        targets,
    })
    // Where the bands overlap, the nearer badge takes the point, and a dimmed one hits nothing.
    const groups = [group(50, []), group(70, ['b'])]
    assert.equal(hitOffscreenGroup(groups, 2, 59, 300), undefined)
    assert.equal(hitOffscreenGroup(groups, 2, 61, 300)?.targets[0], 'b')
    // A dimmed held badge too.
    const held = groupOffscreenNotes(
        [note(-10, -1, 10), { ...note(-10, -1, 40), target: 'b' }],
        300,
        0,
        400,
        24,
        30,
    )
    for (let y = 24; y < 55; y++) assert.equal(hitOffscreenGroup(held, 2, y, 300, 30), undefined)
    assert.equal(hitOffscreenGroup(held, 2, 56, 300, 30)?.targets[0], 'b')
})

test('a band with under half a badge of ride between the held badges keeps one badge fixed to the pane', () => {
    // Bands 56 to 95 px would hop a lone badge twice with under half a badge of ride between.
    for (const band of [56, 70, 83, 84, 90, 95])
        for (const anchor of [-20, 0, 13, 44]) {
            const groups = groupOffscreenNotes(
                [note(-10, -1, -30), note(-10, -1, 10), note(-10, -1, 30)],
                300,
                0,
                band + 48,
                24,
                anchor,
            )
            assert.deepEqual(
                groups.map(({ y, fixed, slot }) => [y, fixed, slot]),
                [[24 + band / 2, true, 0]],
            )
        }
    // From 96 px, held badges.
    assert.deepEqual(drawn(groupOffscreenNotes([note(-10, -1, 10)], 300, 0, 144, 24, 20), 20), [
        [38, 1, true],
    ])
    // A lone badge rides at least half a badge between its hops.
    for (const band of [96, 100, 111]) {
        let ride = 0
        for (let anchor = -100; anchor < band + 100; anchor += 0.25) {
            const [badge] = groupOffscreenNotes([note(-10, -1, 0)], 300, 0, band + 48, 24, anchor)
            if (badge && !badge.fixed) ride += 0.25
        }
        assert.ok(ride >= 12, `${band}: ${ride}`)
    }
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
