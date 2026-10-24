import assert from 'node:assert/strict'
import test from 'node:test'
import {
    combineSelection,
    groupOffscreenEdgeNotes,
    groupOffscreenNotes,
    hitOffscreenGroup,
    isSameOffscreenGroups,
    offscreenBadgeHitWidth,
    placeOffscreenSlots,
    slotOffscreenNotes,
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

test('slotted notes get the badges grouping gives them, in its order, at any anchor', () => {
    let seed = 1
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    // Both sides and the lanes, a seventh on slot boundaries, mixed selection, dimming and targets.
    const notes: OffscreenNotePosition<string>[] = Array.from({ length: 200 }, (_, index) => {
        const left = [-40, -10, 100, 305, 320][index % 5]!
        return {
            left,
            right: left + 8,
            y: index % 7 ? Math.round(random() * 1600) - 400 : 28 * Math.round(random() * 56 - 14),
            highlighted: random() < 0.1,
            opacity: random() < 0.2 ? 0.25 : 1,
            ...(random() < 0.7 ? { target: String(index) } : {}),
        }
    })
    notes.push({ ...note(NaN, -1), target: 'nan' })
    const slots = slotOffscreenNotes(notes, 300)
    // The main pane's band, the elevation editor's, a short band, and ones too small for a badge.
    for (const [top, bottom, inset] of [
        [0, 400, 24],
        [84, 400, 0],
        [0, 100, 0],
        [0, 40, 0],
        [0, 20, 0],
    ] as const)
        // Half pixels meet every hold and exit exactly.
        for (let anchor = -1300; anchor <= 500; anchor += 0.5)
            assert.deepEqual(
                placeOffscreenSlots(slots, top, bottom, inset, anchor),
                groupOffscreenNotes(notes, 300, top, bottom, inset, anchor),
                `${top} ${bottom} ${anchor}`,
            )
    assert.deepEqual(placeOffscreenSlots(slotOffscreenNotes(notes, 0), 0, 400, 24), [])
})

test('slotting again keeps only the badges whose notes are unchanged', () => {
    const notes = [
        { ...note(-10, -1, 100), target: 'a' },
        { ...note(-10, -1, 200), target: 'b' },
        { ...note(310, 320, 200), target: 'c' },
    ]
    const previous = slotOffscreenNotes(notes, 300)
    const before = placeOffscreenSlots(previous, 0, 400, 24)
    const slots = slotOffscreenNotes(
        [notes[0]!, { ...notes[1]!, highlighted: true }, { ...notes[2]!, target: 'd' }],
        300,
        previous,
    )
    const after = placeOffscreenSlots(slots, 0, 400, 24)
    assert.equal(after[0], before[0])
    // A selection or a peek changes them.
    assert.notEqual(after[1], before[1])
    assert.equal(after[1]!.highlighted, true)
    assert.notEqual(after[2], before[2])
    assert.deepEqual(after[2]!.targets, ['d'])
})

// A 600 by 400 pane whose cells are clear of 60px at either side, from lane x 300.
const edges = {
    above: 0,
    below: 400,
    floor: 360,
    left: 60,
    right: 540,
    reachLeft: 0,
    reachRight: 600,
    origin: 300,
    pixelRatio: 1,
}
const groupWithEdges = (notes: OffscreenNotePosition<string>[]) => {
    const args = [600, 0, 400, 0, 0] as const
    return [
        ...groupOffscreenNotes(notes, ...args),
        ...groupOffscreenEdgeNotes(notes, ...args, edges),
    ]
}

test('every note off the pane is on one badge, the sides keeping theirs', () => {
    const notes = [
        // In view.
        note(290, 310, 200),
        // Off the sides, in their bands; one just above, held at the top of its side.
        note(-20, -10, 200),
        note(-20, -10, -10),
        note(610, 620, 200),
        // Above and below.
        note(290, 310, -50),
        note(290, 310, 450),
        // Off a side and far above: past the side band, so on the top row.
        note(-20, -10, -500),
        note(610, 620, 900),
    ]
    const groups = groupWithEdges(notes)
    assert.deepEqual(
        groups.map(({ side, count }) => [side, count]),
        [
            ['left', 1],
            ['left', 1],
            ['right', 1],
            ['top', 1],
            ['bottom', 1],
            ['top', 1],
            ['bottom', 1],
        ],
    )
    assert.equal(
        groups.reduce((sum, group) => sum + group.count, 0),
        notes.length - 1,
    )
    // The side badges are the main editor's.
    assert.deepEqual(
        groupOffscreenNotes(notes, 600, 0, 400),
        groups.filter(({ side }) => side === 'left' || side === 'right'),
    )
})

test('top and bottom badges sit in cells at their notes, held at the row ends', () => {
    const groups = groupOffscreenEdgeNotes(
        [
            // Lane x 300 is a cell centre; these share it.
            note(280, 300, -50),
            note(310, 330, -80),
            // The next cell.
            note(330, 350, -50),
            // Past either end, held in the end cells.
            note(-100, -90, -50),
            note(10, 20, -50),
            note(700, 710, -50),
            note(300, 300, 450),
        ],
        600,
        20,
        400,
        0,
        0,
        edges,
    )
    assert.deepEqual(
        groups.map(({ side, count, x, y }) => [side, count, x, y]),
        [
            ['top', 2, 300, 34],
            ['top', 1, 348, 34],
            // The first and last whole cells within 60 to 540.
            ['top', 2, 108, 34],
            ['top', 1, 492, 34],
            // Above the toolbar.
            ['bottom', 1, 300, 346],
        ],
    )
    // Too narrow for a cell: one badge in the middle.
    const narrow = groupOffscreenEdgeNotes(
        [note(0, 10, -50), note(90, 100, -50)],
        100,
        0,
        400,
        0,
        0,
        {
            ...edges,
            left: 30,
            right: 70,
            origin: 0,
        },
    )
    assert.deepEqual(
        narrow.map(({ count, x }) => [count, x]),
        [[2, 50]],
    )
})

test('top and bottom cells tile their rows a touch target tall', () => {
    const groups = groupOffscreenEdgeNotes(
        [
            { ...note(290, 310, -50), target: 'a' },
            { ...note(340, 350, -50), target: 'b' },
            note(390, 400, -50),
        ],
        600,
        0,
        400,
        0,
        0,
        edges,
    )
    const [a, b] = groups
    assert.equal(hitOffscreenGroup(groups, 300, a!.y, 600), a)
    // Adjacent cells meet with no gap.
    assert.equal(hitOffscreenGroup(groups, 324, a!.y, 600), a)
    assert.equal(hitOffscreenGroup(groups, 324.01, a!.y, 600), b)
    assert.equal(hitOffscreenGroup(groups, 300, a!.y + 22, 600), a)
    assert.equal(hitOffscreenGroup(groups, 300, a!.y + 22.01, 600), undefined)
    // A cell without selectable notes takes its area.
    assert.equal(hitOffscreenGroup(groups, 396, a!.y, 600), undefined)
    assert.equal(hitOffscreenGroup(groups, 250, a!.y, 600), undefined)
})

test('groupings with top and bottom badges compare their xs', () => {
    // Scrolled: the same cell, moved.
    const at = (origin: number) =>
        groupOffscreenEdgeNotes([note(origin, origin, -50)], 600, 0, 400, 0, 0, {
            ...edges,
            origin,
        })
    assert.ok(isSameOffscreenGroups(at(300), at(300)))
    assert.equal(at(310)[0]!.slot, at(300)[0]!.slot)
    assert.ok(!isSameOffscreenGroups(at(300), at(310)))
})

// The Elevation Editor's arguments for a pane under a 48px header, at the chart's 16 lane zoom.
const editorGrouping = (
    notes: OffscreenNotePosition<string>[],
    width: number,
    height: number,
    anchor: number,
    reach = { left: 0, right: 0 },
) => {
    const header = 48
    const laneScale = width / (16 * 1.1)
    const edges = {
        above: header - laneScale * 0.3,
        below: height + laneScale * 0.3,
        floor: height - 60,
        left: Math.max(42, reach.left + 30),
        right: width - reach.right - 4,
        reachLeft: reach.left,
        reachRight: width - reach.right,
        origin: Math.round(width / 2),
        pixelRatio: 1,
    }
    const args = [width, header + 4, height, 0, anchor] as const
    return {
        edges,
        groups: [
            ...groupOffscreenNotes(notes, ...args),
            ...groupOffscreenEdgeNotes(notes, ...args, edges),
        ],
    }
}

test('every note off the pane is on one badge at any anchor, past the side bands too', () => {
    for (const [width, height] of [
        [1600, 900],
        [700, 900],
        [390, 760],
    ] as const) {
        for (const anchor of [0, 7.25, 13.5, 21.75, 100.3]) {
            const notes: OffscreenNotePosition<string>[] = []
            for (let y = -400; y <= height + 400; y++)
                for (const [left, right] of [
                    [-30, -20],
                    [width / 2 - 10, width / 2 + 10],
                    [width + 20, width + 30],
                ] as const)
                    notes.push({ ...note(left, right, y - anchor), target: `${left} ${y}` })
            const { edges, groups } = editorGrouping(notes, width, height, anchor)
            const shown = groups.flatMap((group) => group.targets)
            const off = notes.filter(
                (note) =>
                    note.right < 0 ||
                    note.left > width ||
                    anchor + note.y < edges.above ||
                    anchor + note.y > edges.below,
            )
            const name = `${width} ${anchor}`
            assert.equal(new Set(shown).size, shown.length, name)
            assert.deepEqual(new Set(shown), new Set(off.map((note) => note.target)), name)
        }
    }
})

test('a pane without a size has no top or bottom badges', () => {
    const notes = [note(-20, -10, -500), note(290, 310, -50)]
    const { edges } = editorGrouping(notes, 600, 400, 0)
    assert.deepEqual(groupOffscreenEdgeNotes(notes, 0, 52, 0, 0, 0, edges), [])
    assert.deepEqual(groupOffscreenEdgeNotes(notes, 600, 52, 52, 0, 0, edges), [])
})

test('the end cells reach the side badges, so the top row tiles with them', () => {
    const reach = offscreenBadgeHitWidth(1)
    // Held at the top of either side, and far past either end of the top row.
    const notes = [
        { ...note(-20, -10, 70), target: 'left' },
        { ...note(610, 620, 70), target: 'right' },
        { ...note(-300, -290, -50), target: 'top left' },
        { ...note(900, 910, -50), target: 'top right' },
    ]
    const { groups } = editorGrouping(notes, 600, 400, 0, { left: reach, right: reach })
    const top = groups.filter(({ side }) => side === 'top')
    assert.equal(top.length, 2)
    const y = top[0]!.y
    assert.ok(groups.some(({ side, fixed, y: held }) => side === 'left' && fixed && held === y))
    for (let x = 0; x <= 600; x += 0.5) {
        const hit = hitOffscreenGroup(groups, x, y, 600)
        const expected = x < reach ? 'left' : x > 600 - reach ? 'right' : undefined
        if (expected) assert.equal(hit?.side, expected, `${x}`)
        else if (x <= top[0]!.x! + 24 || x >= top[1]!.x! - 24)
            assert.equal(hit?.side, 'top', `${x}`)
    }
    // One badge for the row reaches across it.
    const narrow = editorGrouping([notes[2]!], 120, 400, 0, { left: 20, right: 20 })
    const [single] = narrow.groups
    assert.deepEqual([single!.hitLeft, single!.hitRight], [20, 100])
})

test('top and bottom badges land on device pixels', () => {
    for (const [pixelRatio, x, bottom] of [
        [1, 50, 346],
        [2, 50.5, 345.5],
    ] as const) {
        const [single] = groupOffscreenEdgeNotes([note(0, 10, -50)], 100, 0, 400, 0, 0, {
            ...edges,
            left: 30.6,
            right: 70,
            origin: 0,
            pixelRatio,
        })
        assert.equal(single!.x, x)
        const [row] = groupOffscreenEdgeNotes([note(290, 310, 450)], 600, 0, 400, 0, 0, {
            ...edges,
            floor: 359.7,
            pixelRatio,
        })
        assert.equal(row!.y, bottom)
    }
})
