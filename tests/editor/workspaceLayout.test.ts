import assert from 'node:assert/strict'
import test from 'node:test'
import { oneRowToolbarWidth } from '../../src/editor/toolbar/layout'
import {
    carryAcrossShape,
    coarseRailSize,
    computeWorkspaceLayout,
    defaultDockSize,
    distribute,
    hasRoomFor,
    railSize,
    reduceWorkspace,
    resizeTilePair,
    resizeTileUnits,
    resolveAutoSide,
    separatorSize,
    tabAction,
    touchRecency,
    type PanelId,
    type PanelPosition,
    type SideBySideChoice,
    type WorkspaceAction,
    type WorkspaceLayoutInput,
    type WorkspaceToggleState,
} from '../../src/editor/workspace/layout'

// The default toolbar shows 18 tools.
const defaultTools = 18

const input = (overrides: Partial<WorkspaceLayoutInput> = {}): WorkspaceLayoutInput => ({
    width: 1600,
    height: 1000,
    positions: {
        preview: 'auto',
        groups: 'auto',
        stages: 'auto',
        properties: 'auto',
        history: 'auto',
    },
    open: { preview: true, groups: false, stages: false, properties: true, history: false },
    recency: ['preview', 'properties', 'groups', 'stages'],
    sizes: { left: 0, right: 0, top: 0 },
    weights: {},
    previewAspectRatio: 16 / 9,
    toolbarWidth: oneRowToolbarWidth(defaultTools, 16, false),
    ...overrides,
})

const positions = (position: PanelPosition): Record<PanelId, PanelPosition> => ({
    preview: position,
    groups: position,
    stages: position,
    properties: position,
    history: position,
})

test('pointer class keeps the same rails and preview reservation', () => {
    for (const [width, height] of [
        [390, 844],
        [820, 1180],
        [1280, 683],
        [1600, 1000],
    ]) {
        const base = input({ width, height })
        assert.deepEqual(
            computeWorkspaceLayout({ ...base, coarse: true, railSize: coarseRailSize }),
            computeWorkspaceLayout({ ...base, coarse: false, railSize }),
        )
    }
})

test('auto placement follows the workspace shape rather than width alone', () => {
    assert.equal(resolveAutoSide(1600, 1000, 'preview'), 'left')
    assert.equal(resolveAutoSide(1600, 1000, 'properties'), 'right')
    // Portrait tablets share a top dock even though they are wider than a phone.
    assert.equal(resolveAutoSide(820, 1180, 'properties'), 'top')
    assert.equal(resolveAutoSide(1024, 1366, 'groups'), 'top')
    // Medium landscape screens keep the editor wide with a single side dock.
    assert.equal(resolveAutoSide(844, 390, 'properties'), 'left')
    assert.equal(resolveAutoSide(390, 844, 'preview'), 'top')
})

test('desktop places managers with preview and properties on the right', () => {
    const layout = computeWorkspaceLayout(
        input({
            open: { preview: true, groups: true, stages: true, properties: true, history: false },
        }),
    )
    assert.deepEqual(layout.docks.left?.panels, ['preview', 'groups', 'stages'])
    assert.deepEqual(layout.docks.left?.visible, ['preview', 'groups', 'stages'])
    assert.deepEqual(layout.docks.right?.visible, ['properties'])
    assert.equal(layout.docks.top, undefined)
    const tiles = layout.docks.left?.tiles ?? []
    const total = tiles.reduce((sum, tile) => sum + tile.size, 0)
    assert.ok(Math.abs(total + 2 * separatorSize - 1000) < 1e-6)
})

test('a dock keeps its rail when every panel is closed', () => {
    const layout = computeWorkspaceLayout(
        input({
            open: {
                preview: false,
                groups: false,
                stages: false,
                properties: false,
                history: false,
            },
        }),
    )
    assert.equal(layout.docks.left?.size, 0)
    assert.deepEqual(layout.docks.left?.panels, ['preview', 'groups', 'stages'])
    assert.deepEqual(layout.docks.left?.visible, [])
})

test('limited room shows the most recent open panels without closing the others', () => {
    const open = { preview: true, groups: true, stages: true, properties: true, history: false }
    const phone = computeWorkspaceLayout(
        input({
            width: 390,
            height: 844,
            open,
            recency: ['groups', 'preview', 'stages', 'properties'],
        }),
    )
    const top = phone.docks.top
    assert.ok(top)
    assert.deepEqual(top.open, ['preview', 'groups', 'stages', 'properties'])
    assert.deepEqual(top.visible, ['groups'])

    // Intermediate capacity: two of three open panels fit, in tab order.
    const short = computeWorkspaceLayout(
        input({
            height: 460,
            positions: positions('left'),
            open: { preview: true, groups: true, stages: true, properties: false, history: false },
            recency: ['stages', 'preview', 'groups', 'properties'],
        }),
    )
    assert.deepEqual(short.docks.left?.visible, ['preview', 'stages'])
    assert.equal(tabAction(short, open, 'groups'), 'activate')
    assert.equal(tabAction(short, open, 'stages'), 'close')
    assert.equal(tabAction(short, { ...open, properties: false }, 'properties'), 'open')
})

test('explicit positions override auto placement and disabled panels have no tab', () => {
    const layout = computeWorkspaceLayout(
        input({
            width: 390,
            height: 844,
            positions: {
                preview: 'right',
                groups: 'disabled',
                stages: 'top',
                properties: 'left',
                history: 'disabled',
            },
        }),
    )
    assert.deepEqual(layout.docks.right?.panels, ['preview'])
    assert.deepEqual(layout.docks.left?.panels, ['properties'])
    assert.deepEqual(layout.docks.top?.panels, ['stages'])
    assert.equal(layout.sides.groups, undefined)
})

test('dock sizes clamp for display without changing the saved preference', () => {
    const sizes = { left: 5000, right: 0, top: 0 }
    const layout = computeWorkspaceLayout(input({ width: 900, height: 600, sizes }))
    const left = layout.docks.left
    assert.ok(left)
    assert.ok(left.size <= left.max)
    // The editor keeps a usable width beside the dock and its rail.
    assert.ok(900 - railSize - left.size >= 320)
    assert.equal(sizes.left, 5000)

    const tiny = computeWorkspaceLayout(
        input({ width: 390, height: 844, sizes: { left: 0, right: 0, top: 10 } }),
    )
    assert.ok((tiny.docks.top?.size ?? 0) >= (tiny.docks.top?.min ?? Infinity))
})

test('opposite side docks share the room left beside the editor', () => {
    const layout = computeWorkspaceLayout(
        input({
            width: 1200,
            height: 800,
            positions: {
                preview: 'left',
                groups: 'left',
                stages: 'left',
                properties: 'right',
                history: 'auto',
            },
            sizes: { left: 600, right: 600, top: 0 },
        }),
    )
    const left = layout.docks.left?.size ?? 0
    const right = layout.docks.right?.size ?? 0
    assert.ok(1200 - 2 * railSize - left - right >= 320)
    assert.ok(right >= 220)
})

test('weights distribute stack sizes and respect minimums', () => {
    assert.deepEqual(
        distribute(300, [
            { min: 0, weight: 1 },
            { min: 0, weight: 2 },
        ]),
        [100, 200],
    )
    assert.deepEqual(
        distribute(300, [
            { min: 150, weight: 1 },
            { min: 0, weight: 9 },
        ]),
        [150, 150],
    )
    const [a, b] = distribute(100, [
        { min: 100, weight: 1 },
        { min: 100, weight: 1 },
    ])
    assert.equal(a, 50)
    assert.equal(b, 50)
})

test('resizing a tile pair keeps their combined weight', () => {
    const weights = resizeTilePair(
        { id: 'groups', size: 200, min: 100, weight: 1 },
        { id: 'stages', size: 200, min: 100, weight: 1 },
        300,
    )
    assert.equal(weights.groups, 1.5)
    assert.equal(weights.stages, 0.5)
    const clamped = resizeTilePair(
        { id: 'groups', size: 200, min: 100, weight: 1 },
        { id: 'stages', size: 200, min: 100, weight: 1 },
        390,
    )
    assert.equal(clamped.groups, 1.5)
})

test('recency moves an activated panel to the front', () => {
    assert.deepEqual(touchRecency(['preview', 'properties', 'groups', 'stages'], 'groups'), [
        'groups',
        'preview',
        'properties',
        'stages',
    ])
})

test('hiding the only visible panel collapses its dock instead of revealing another', () => {
    const open = { preview: true, groups: false, stages: false, properties: true, history: false }
    const phone = (collapsed: boolean) =>
        computeWorkspaceLayout(
            input({ width: 390, height: 844, open, collapsed: { top: collapsed } }),
        )
    const expanded = phone(false)
    assert.deepEqual(expanded.docks.top?.visible, ['preview'])
    assert.deepEqual(expanded.docks.top?.covered, ['properties'])
    assert.equal(tabAction(expanded, open, 'preview'), 'collapse')
    assert.equal(tabAction(expanded, open, 'properties'), 'activate')

    const collapsed = phone(true)
    assert.deepEqual(collapsed.docks.top?.visible, [])
    assert.deepEqual(collapsed.docks.top?.open, ['preview', 'properties'])
    assert.equal(collapsed.docks.top?.size, 0)
    assert.equal(tabAction(collapsed, open, 'groups'), 'expand')
})

test('side docks too narrow to share the screen with the editor become drawers', () => {
    const layout = computeWorkspaceLayout(
        input({ width: 390, height: 844, positions: positions('right') }),
    )
    const right = layout.docks.right
    assert.ok(right)
    assert.equal(right.overlay, true)
    assert.ok(right.size >= 220)
    assert.equal(layout.docks.top, undefined)
})

test('a side dock grows only into room the other side is not using', () => {
    const base = input({
        width: 1600,
        height: 1000,
        positions: {
            preview: 'left',
            groups: 'left',
            stages: 'left',
            properties: 'right',
            history: 'auto',
        },
    })
    const before = computeWorkspaceLayout(base)
    const max = before.docks.left?.max ?? 0
    const after = computeWorkspaceLayout({ ...base, sizes: { left: max, right: 0, top: 0 } })
    assert.equal(after.docks.right?.size, before.docks.right?.size)
    assert.equal(after.docks.left?.size, max)
})

test('hiding one side dock never resizes the other', () => {
    const base = input({
        positions: {
            preview: 'left',
            groups: 'left',
            stages: 'left',
            properties: 'right',
            history: 'auto',
        },
    })
    const both = computeWorkspaceLayout(base)
    const leftOnly = computeWorkspaceLayout({ ...base, collapsed: { right: true } })
    const rightOnly = computeWorkspaceLayout({ ...base, collapsed: { left: true } })
    assert.equal(leftOnly.docks.left?.size, both.docks.left?.size)
    assert.equal(rightOnly.docks.right?.size, both.docks.right?.size)
})

test('the toolbar needs room for its tools and the padding around them', () => {
    // 18 tools fill the 36rem row, inside the smallest padding.
    assert.equal(oneRowToolbarWidth(18, 16, false), 18 * 32 + 24)
    assert.equal(oneRowToolbarWidth(18, 16, true), 18 * 32 + 24)
    assert.equal(oneRowToolbarWidth(18, 20, false), 18 * 32 + 30)
    // Beyond the row width the padding grows to its largest before the room does.
    assert.equal(oneRowToolbarWidth(19, 16, false), 19 * 32 + 256)
    assert.equal(oneRowToolbarWidth(19, 16, true), 19 * 32 + 24)
})

test('side docks default to 24rem, leaving the toolbar one row between both, never below 260', () => {
    const side = (width: number, rem?: number, rail = railSize, coarse = false) =>
        defaultDockSize('left', width, 1000, {
            rem,
            rail,
            toolbar: oneRowToolbarWidth(defaultTools, rem ?? 16, coarse),
        })
    assert.equal(side(1280), 304)
    assert.equal(side(1366), 347)
    assert.equal(side(1440), 384)
    assert.equal(side(1439), 383)
    assert.equal(side(1600), 384)
    assert.equal(side(1920), 384)
    // Both docks at the default leave the toolbar exactly its row.
    for (const width of [1280, 1366, 1400])
        assert.ok(
            width - 2 * railSize - 2 * side(width) >= oneRowToolbarWidth(defaultTools, 16, false),
        )
    // Rails share their size while the toolbar retains its pointer-specific layout.
    assert.equal(coarseRailSize, railSize)
    assert.equal(side(1280, 16, coarseRailSize, true), 304)
    // The root font size scales the aim and the toolbar's padding.
    assert.equal(side(1920, 20), 480)
    assert.equal(side(1600, 20), 461)
    assert.equal(side(1600, 12), 288)
    // Small text narrows the toolbar's row, so its padding grows first.
    assert.equal(side(1280, 12), 260)
    // Narrow windows and small text keep the floor.
    assert.equal(side(1191), 260)
    assert.equal(side(900), 260)
    assert.equal(side(390), 260)
    assert.equal(side(1920, 8), 260)
    // Without a toolbar only the rails limit it.
    assert.equal(defaultDockSize('left', 800, 1000), 364)
    // The top dock follows the height alone.
    assert.equal(
        defaultDockSize('top', 1600, 1000, { rem: 20, toolbar: 900 }),
        defaultDockSize('top', 1600, 1000),
    )
})

test('unsized side docks use the default, scaled by the root font size', () => {
    const base = input({
        positions: {
            preview: 'left',
            groups: 'left',
            stages: 'left',
            properties: 'right',
            history: 'auto',
        },
    })
    const sizes = (layout: ReturnType<typeof computeWorkspaceLayout>) => [
        layout.docks.left?.size,
        layout.docks.right?.size,
        layout.docks.right?.default,
    ]
    assert.deepEqual(sizes(computeWorkspaceLayout(base)), [384, 384, 384])
    assert.deepEqual(
        sizes(computeWorkspaceLayout({ ...base, width: 1280, height: 800 })),
        [304, 304, 304],
    )
    const large = { rootFontSize: 18, toolbarWidth: oneRowToolbarWidth(defaultTools, 18, false) }
    assert.deepEqual(sizes(computeWorkspaceLayout({ ...base, ...large })), [432, 432, 432])
    // Stored sizes still win.
    const stored = computeWorkspaceLayout({ ...base, sizes: { left: 300, right: 336, top: 0 } })
    assert.deepEqual(sizes(stored), [300, 336, 384])
    // A phone held sideways keeps the floor beside the editor.
    const phone = computeWorkspaceLayout({ ...base, width: 844, height: 390 })
    assert.equal(phone.docks.left?.overlay, false)
    assert.equal(phone.docks.left?.size, phone.docks.right?.size)
})

test('collapsing the shown side does not reveal the other side in its place', () => {
    const base = input({
        width: 480,
        height: 800,
        positions: {
            preview: 'left',
            groups: 'left',
            stages: 'left',
            properties: 'right',
            history: 'auto',
        },
        recency: ['preview', 'properties', 'groups', 'stages'],
    })
    const shown = computeWorkspaceLayout(base)
    assert.deepEqual(shown.docks.left?.visible, ['preview'])
    assert.deepEqual(shown.docks.right?.visible, [])
    const collapsed = computeWorkspaceLayout({ ...base, collapsed: { left: true } })
    assert.deepEqual(collapsed.docks.left?.visible, [])
    assert.deepEqual(collapsed.docks.right?.visible, [])
})

test('an unsized top dock fits the width Preview has, alone or in a row of tiles', () => {
    const tablet = (recency: PanelId[]) =>
        computeWorkspaceLayout(
            input({
                width: 820,
                height: 1180,
                coarse: true,
                open: {
                    preview: true,
                    groups: true,
                    stages: false,
                    properties: true,
                    history: false,
                },
                recency,
            }),
        ).docks.top
    // Tiled beside Groups and Properties, Preview is narrow: the dock stops at
    // the height that still docks its playback bar instead of leaving bands.
    const tiled = tablet(['preview', 'groups', 'properties', 'stages'])
    assert.deepEqual(tiled?.visible, ['preview', 'groups', 'properties'])
    const preview = tiled?.tiles.find(({ id }) => id === 'preview')
    assert.ok(preview && preview.size / (16 / 9) + 52 <= (tiled?.size ?? 0))
    assert.equal(tiled?.size, 260)
    // Alone in the dock, Preview spans it and the default height applies.
    const alone = computeWorkspaceLayout(
        input({
            width: 820,
            height: 1180,
            coarse: true,
            open: { ...input().open, properties: false },
        }),
    ).docks.top
    assert.equal(alone?.size, 420)
    // Switching the shown tab keeps the height.
    assert.equal(tablet(['groups', 'properties', 'preview', 'stages'])?.size, 260)
})

test('a stacked Preview fits its image, plus the playback strip unless it overlays', () => {
    const tile = (previewOverlay: boolean) =>
        computeWorkspaceLayout(
            input({
                positions: { ...positions('auto'), preview: 'left', groups: 'left' },
                open: {
                    preview: true,
                    groups: true,
                    stages: false,
                    properties: true,
                    history: false,
                },
                previewAspectRatio: 4 / 3,
                previewOverlay,
            }),
        ).docks.left?.tiles.find(({ id }) => id === 'preview')?.size
    assert.ok(Math.abs((tile(false) ?? 0) - (384 / (4 / 3) + 52)) < 1e-6)
    assert.ok(Math.abs((tile(true) ?? 0) - 384 / (4 / 3)) < 1e-6)
})

const visibleOf = (layout: ReturnType<typeof computeWorkspaceLayout>) =>
    Object.values(layout.docks).flatMap((dock) => dock.visible)

/** Plays actions on a screen, returning what is shown after each one. */
const play = (
    screen: Partial<WorkspaceLayoutInput>,
    state: WorkspaceToggleState,
    actions: WorkspaceAction[],
) => {
    const layoutOf = (state: WorkspaceToggleState) =>
        computeWorkspaceLayout(input({ ...screen, ...state }))
    const shown: PanelId[][] = []
    let current = state
    for (const action of actions) {
        current = reduceWorkspace(current, action, layoutOf)
        shown.push(visibleOf(layoutOf(current)))
    }
    return { shown, state: current }
}

const unfolded = { left: false, right: false, top: false }
const tabletPortrait = { width: 820, height: 1180, coarse: true, railSize }
const tabletLandscape = { width: 1180, height: 820, coarse: true, railSize }

test('hiding one of several shown panels never reveals one it covered', () => {
    // A portrait tablet's top dock fits three panels side by side.
    const { shown, state } = play(
        tabletPortrait,
        {
            open: { preview: true, groups: true, stages: false, properties: false, history: false },
            recency: ['preview', 'groups', 'stages', 'properties'],
            collapsed: unfolded,
        },
        [
            { type: 'tab', id: 'stages' },
            { type: 'tab', id: 'properties' },
            { type: 'tab', id: 'properties' },
        ],
    )
    assert.deepEqual(shown, [
        ['preview', 'groups', 'stages'],
        // Groups, the least recent, makes room and is closed, not covered.
        ['preview', 'stages', 'properties'],
        ['preview', 'stages'],
    ])
    assert.equal(state.open.groups, false)
})

test('closing a panel by key or menu never reveals a covered one either', () => {
    // A phone's top dock fits one panel; Properties starts covered by Preview.
    const { shown, state } = play(
        { width: 390, height: 844, coarse: true, railSize },
        {
            open: { preview: true, groups: false, stages: false, properties: true, history: false },
            recency: ['preview', 'properties', 'groups', 'stages'],
            collapsed: unfolded,
        },
        [{ type: 'close', id: 'preview' }],
    )
    assert.deepEqual(shown, [[]])
    assert.equal(state.open.properties, false)
})

test('a tab or command on a folded dock shows just that panel', () => {
    const actions: WorkspaceAction[] = [
        { type: 'tab', id: 'groups' },
        { type: 'show', id: 'groups' },
    ]
    for (const action of actions) {
        const { shown } = play(
            tabletLandscape,
            {
                open: {
                    preview: true,
                    groups: false,
                    stages: true,
                    properties: true,
                    history: false,
                },
                recency: ['preview', 'stages', 'properties', 'groups'],
                collapsed: { left: true, right: false, top: false },
            },
            [action, { type: 'toggleDock', side: 'left' }, { type: 'toggleDock', side: 'left' }],
        )
        assert.deepEqual(shown, [
            ['groups', 'properties'],
            // The chevron folds and restores exactly what was shown.
            ['properties'],
            ['groups', 'properties'],
        ])
    }
})

test('the chevron restores every panel a dock showed when folded', () => {
    const { shown } = play(
        tabletPortrait,
        {
            open: { preview: true, groups: true, stages: false, properties: false, history: false },
            recency: ['preview', 'groups', 'stages', 'properties'],
            collapsed: unfolded,
        },
        [
            { type: 'toggleDock', side: 'top' },
            { type: 'toggleDock', side: 'top' },
        ],
    )
    assert.deepEqual(shown, [[], ['preview', 'groups']])
})

test('a tab on another panel after folding by tab shows only that panel', () => {
    const { shown, state } = play(
        tabletPortrait,
        {
            open: {
                preview: true,
                groups: false,
                stages: false,
                properties: false,
                history: false,
            },
            recency: ['preview', 'groups', 'stages', 'properties'],
            collapsed: unfolded,
        },
        [
            { type: 'tab', id: 'preview' },
            { type: 'tab', id: 'groups' },
        ],
    )
    assert.deepEqual(shown, [[], ['groups']])
    assert.equal(state.open.preview, false)
})

test('a side dock held back for the other side never returns on its own', () => {
    // Too narrow for both sides: showing one side closes the other's panels.
    const screen: Partial<WorkspaceLayoutInput> = {
        ...tabletPortrait,
        positions: {
            preview: 'top',
            groups: 'left',
            stages: 'top',
            properties: 'right',
            history: 'auto',
        },
    }
    const { shown, state } = play(
        screen,
        {
            open: {
                preview: false,
                groups: true,
                stages: false,
                properties: false,
                history: false,
            },
            recency: ['groups', 'preview', 'stages', 'properties'],
            collapsed: unfolded,
        },
        [
            { type: 'tab', id: 'properties' },
            { type: 'tab', id: 'properties' },
            { type: 'close', id: 'properties' },
        ],
    )
    assert.deepEqual(shown, [['properties'], [], []])
    assert.equal(state.open.groups, false)
})

test('rotating a tablet keeps exactly the same panels shown', () => {
    const layoutIn = (screen: Partial<WorkspaceLayoutInput>, state: WorkspaceToggleState) =>
        computeWorkspaceLayout(input({ ...screen, ...state }))
    const rotate = (
        state: WorkspaceToggleState,
        from: Partial<WorkspaceLayoutInput>,
        to: Partial<WorkspaceLayoutInput>,
    ) => carryAcrossShape(layoutIn(from, state), layoutIn(to, state), state)

    // Folded in portrait, Preview and Properties stay hidden in landscape,
    // where they land in two different docks, and the chevrons restore them.
    const folded: WorkspaceToggleState = {
        open: { preview: true, groups: false, stages: false, properties: true, history: false },
        recency: ['preview', 'properties', 'groups', 'stages'],
        collapsed: { left: false, right: false, top: true },
    }
    const turned = rotate(folded, tabletPortrait, tabletLandscape)
    assert.deepEqual(visibleOf(layoutIn(tabletLandscape, turned)), [])
    assert.deepEqual(turned.collapsed, { left: true, right: true, top: true })
    assert.deepEqual(turned.open, folded.open)
    assert.equal(rotate(turned, tabletLandscape, tabletPortrait).collapsed.top, true)

    // Folded on the left in landscape while Properties shows on the right:
    // portrait's shared top dock shows Properties alone.
    const mixed: WorkspaceToggleState = {
        open: { preview: true, groups: true, stages: true, properties: true, history: false },
        recency: ['properties', 'preview', 'groups', 'stages'],
        collapsed: { left: true, right: false, top: false },
    }
    const back = rotate(mixed, tabletLandscape, tabletPortrait)
    assert.deepEqual(visibleOf(layoutIn(tabletPortrait, back)), ['properties'])
    assert.equal(back.collapsed.top, false)
})

test('groups and stages open by default only where they fit beside preview', () => {
    const managers = ['groups', 'stages'] as const
    const room = (overrides: Partial<WorkspaceLayoutInput>) =>
        hasRoomFor(input(overrides), managers)
    for (const [width, height] of [
        [1280, 720],
        [1280, 800],
        [1366, 768],
        [1440, 900],
        [1600, 1000],
        [1920, 1080],
    ])
        assert.ok(room({ width, height }), `${width}x${height}`)
    // Preview keeps its natural size: 1280 wide needs 223 + 2 * 226 + 2 * 4.
    assert.ok(room({ width: 1280, height: 683 }))
    assert.ok(!room({ width: 1280, height: 682 }))
    assert.ok(!room({ width: 1280, height: 600 }))
    // Properties shares the left dock and would cover Stages.
    assert.ok(!room({ width: 1024, height: 768 }))
    // Portrait screens use the top dock, and narrow ones open drawers.
    assert.ok(!room({ width: 820, height: 1180 }))
    assert.ok(!room({ width: 390, height: 844 }))
    assert.ok(!room({ width: 844, height: 390 }))
    // Pointer class does not inflate panel chrome; a 4:3 preview needs more height.
    assert.ok(room({ width: 1280, height: 683, coarse: true, railSize: coarseRailSize }))
    assert.ok(!room({ width: 1280, height: 683, previewAspectRatio: 4 / 3 }))
    // An overlaid playback strip needs only Preview's minimum.
    assert.ok(room({ width: 1280, height: 660, previewOverlay: true }))
    assert.ok(room({ width: 1180, height: 820, coarse: true, railSize: coarseRailSize }))
    // An on-screen keyboard shortens the window but not the held Auto shape.
    assert.ok(room({ width: 1180, height: 470, autoShape: { width: 1180, height: 820 } }))
    // Resized docks and tiles never change the default.
    assert.ok(
        room({
            width: 1280,
            height: 683,
            sizes: { left: 600, right: 0, top: 0 },
            weights: { preview: 3 },
        }),
    )
})

test('a manager moved elsewhere opens by default only where it fits', () => {
    const moved = { ...positions('auto'), stages: 'right' as const }
    assert.ok(hasRoomFor(input({ positions: moved }), ['groups', 'stages']))
    // Properties on the right leaves no room for Stages in a short window.
    assert.ok(!hasRoomFor(input({ height: 420, positions: moved }), ['stages']))
    assert.ok(hasRoomFor(input({ positions: moved }), ['groups']))
    // A top dock never opens managers by default.
    assert.ok(!hasRoomFor(input({ positions: { ...moved, groups: 'top' } }), ['groups']))
})

test('History is an ordinary panel: a tab while closed, shown like Groups, gone when Disabled', () => {
    const phone = (overrides: Partial<WorkspaceLayoutInput> = {}) =>
        computeWorkspaceLayout(input({ width: 390, height: 844, ...overrides }))
    // Closed by default: its tab is there and its body is not.
    const closed = phone()
    assert.deepEqual(closed.docks.top?.panels, [
        'preview',
        'groups',
        'stages',
        'properties',
        'history',
    ])
    assert.deepEqual(closed.docks.top?.visible, ['preview'])
    assert.equal(closed.sides.history, 'top')

    // Opened, it takes the room as Groups would, displacing the open panels it has no room beside.
    const state: WorkspaceToggleState = {
        open: { preview: true, groups: false, stages: false, properties: true, history: false },
        recency: ['preview', 'properties', 'groups', 'stages', 'history'],
        collapsed: { left: false, right: false, top: false },
    }
    const layoutOf = (next: WorkspaceToggleState) => phone({ ...next })
    const shown = reduceWorkspace(state, { type: 'tab', id: 'history' }, layoutOf)
    assert.equal(shown.open.history, true)
    assert.equal(shown.recency[0], 'history')
    assert.equal(layoutOf(shown).docks.top?.visible.includes('history'), true)
    const groups = reduceWorkspace(state, { type: 'tab', id: 'groups' }, layoutOf)
    assert.deepEqual(shown.open, { ...groups.open, groups: false, history: true })

    // As the only panel shown, a second tab click folds the dock and keeps it open.
    const again = reduceWorkspace(shown, { type: 'tab', id: 'history' }, layoutOf)
    assert.deepEqual([again.open.history, again.collapsed.top], [true, true])
    assert.equal(
        reduceWorkspace(shown, { type: 'close', id: 'history' }, layoutOf).open.history,
        false,
    )

    // Auto goes right at 1100, under Properties, and left below.
    assert.equal(resolveAutoSide(1600, 1000, 'history'), 'right')
    assert.equal(resolveAutoSide(1000, 700, 'history'), 'left')

    // Disabled takes the tab away, like the other panels.
    const disabled = phone({ positions: { ...positions('auto'), history: 'disabled' } })
    assert.equal(disabled.sides.history, undefined)
    assert.equal(disabled.docks.top?.panels.includes('history'), false)
})

// Preview, Groups and Stages on the left of a wide screen, Properties and History on the right,
// with Enabled, which sets them side by side at 760 px.
const sideBySide = (overrides: Partial<WorkspaceLayoutInput> = {}) =>
    input({
        width: 2560,
        height: 1440,
        positions: { ...positions('right'), preview: 'left', groups: 'left', stages: 'left' },
        open: { preview: true, groups: true, stages: true, properties: true, history: false },
        recency: ['preview', 'groups', 'stages', 'properties', 'history'],
        sizes: { left: 760, right: 0, top: 0 },
        groupsStagesSideBySide: 'enabled',
        ...overrides,
    })

const tileSizes = (dock: { tiles: { id: PanelId; size: number }[] } | undefined) =>
    Object.fromEntries((dock?.tiles ?? []).map(({ id, size }) => [id, size]))

test('Groups and Stages sit side by side only with Preview, in a wide side dock', () => {
    const shown = (overrides: Partial<WorkspaceLayoutInput>, side: 'left' | 'right' | 'top') =>
        computeWorkspaceLayout(sideBySide(overrides)).docks[side]?.sideBySide
    assert.deepEqual(shown({}, 'left'), { groups: 378, stages: 378, min: 260, max: 496 })
    assert.equal(shown({ groupsStagesSideBySide: 'disabled' }, 'left'), undefined)
    assert.equal(shown({ groupsStagesSideBySide: undefined }, 'left'), undefined)
    // Each of the three must be shown, not only open or placed there.
    for (const id of ['preview', 'groups', 'stages'] as const) {
        assert.equal(shown({ open: { ...sideBySide().open, [id]: false } }, 'left'), undefined, id)
        assert.equal(
            shown({ positions: { ...sideBySide().positions, [id]: 'right' } }, 'left'),
            undefined,
            id,
        )
    }
    // A short dock covers Stages, so the two never sit side by side there.
    const short = computeWorkspaceLayout(sideBySide({ height: 600 })).docks.left
    assert.deepEqual(short?.covered, ['stages'])
    assert.equal(short?.sideBySide, undefined)
    assert.equal(shown({ collapsed: { left: true } }, 'left'), undefined)
    // Properties and History below them leave the arrangement as it is.
    const all = positions('left')
    assert.ok(shown({ positions: all, open: { ...sideBySide().open, history: true } }, 'left'))
    // The right side arranges in the same order; the top dock already has a row of tiles.
    assert.deepEqual(
        shown({ positions: positions('right'), sizes: { left: 0, right: 760, top: 0 } }, 'right'),
        { groups: 378, stages: 378, min: 260, max: 496 },
    )
    assert.equal(
        shown({ positions: positions('top'), sizes: { left: 0, right: 0, top: 760 } }, 'top'),
        undefined,
    )
    // A drawer on a narrow screen is at most 306 px wide.
    const drawer = computeWorkspaceLayout(
        sideBySide({ width: 390, height: 844, sizes: { left: 5000, right: 0, top: 0 } }),
    ).docks.left
    assert.equal(drawer?.overlay, true)
    assert.equal(drawer?.sideBySide, undefined)
})

test('Enabled sets them side by side from 524 px, and Auto from 48rem and the separator', () => {
    const at = (
        left: number,
        groupsStagesSideBySide: SideBySideChoice,
        overrides: Partial<WorkspaceLayoutInput> = {},
    ) =>
        computeWorkspaceLayout(
            sideBySide({ groupsStagesSideBySide, sizes: { left, right: 0, top: 0 }, ...overrides }),
        ).docks.left?.sideBySide
    // Enabled: both at their width in a row of tiles.
    assert.equal(at(523, 'enabled'), undefined)
    assert.deepEqual(at(524, 'enabled'), { groups: 260, stages: 260, min: 260, max: 260 })
    // Auto: each as wide as a side dock's default, 24rem.
    assert.equal(at(771, 'auto'), undefined)
    assert.deepEqual(at(772, 'auto'), { groups: 384, stages: 384, min: 260, max: 508 })
    const text = (rem: number) => ({
        rootFontSize: rem,
        toolbarWidth: oneRowToolbarWidth(defaultTools, rem, false),
    })
    assert.equal(at(963, 'auto', text(20)), undefined)
    assert.ok(at(964, 'auto', text(20)))
    // Small text still needs room for both.
    assert.equal(at(523, 'auto', text(10)), undefined)
    assert.ok(at(524, 'auto', text(10)))
    assert.equal(at(2000, 'disabled'), undefined)
    // A saved width the window cannot show counts as the width shown.
    const narrow = computeWorkspaceLayout(
        sideBySide({ width: 1100, sizes: { left: 600, right: 0, top: 0 } }),
    ).docks.left
    assert.ok(narrow && narrow.size < 524)
    assert.equal(narrow.sideBySide, undefined)
    // At their default width, docks never pair on Auto, whatever the text size.
    for (const rem of [8, 12, 16, 20, 24, 32]) {
        const left = computeWorkspaceLayout(
            sideBySide({
                ...text(rem),
                groupsStagesSideBySide: 'auto',
                sizes: { left: 0, right: 0, top: 0 },
            }),
        ).docks.left
        assert.equal(left?.sideBySide, undefined, String(rem))
    }
})

test('the managers side by side change no panel shown, covered or closed', () => {
    const docks = (overrides: Partial<WorkspaceLayoutInput>) =>
        Object.values(computeWorkspaceLayout(input(overrides)).docks).map((dock) => ({
            side: dock.side,
            visible: dock.visible,
            covered: dock.covered,
            collapsed: dock.collapsed,
        }))
    const opens = [
        { preview: true, groups: true, stages: true, properties: true, history: true },
        { preview: true, groups: true, stages: true, properties: false, history: true },
        { preview: true, groups: true, stages: true, properties: true, history: false },
    ]
    const recencies: PanelId[][] = [
        ['history', 'properties', 'stages', 'groups', 'preview'],
        ['preview', 'groups', 'stages', 'properties', 'history'],
    ]
    for (const height of [500, 660, 700, 900, 1100, 1440])
        for (const open of opens)
            for (const placement of [positions('left'), positions('right')])
                for (const size of [540, 800])
                    for (const recency of recencies) {
                        const screen = {
                            width: 2560,
                            height,
                            positions: placement,
                            open,
                            recency,
                            sizes: { left: size, right: size, top: 0 },
                        }
                        for (const choice of ['auto', 'enabled'] as const)
                            assert.deepEqual(
                                docks({ ...screen, groupsStagesSideBySide: choice }),
                                docks({ ...screen, groupsStagesSideBySide: 'disabled' }),
                                JSON.stringify(screen),
                            )
                    }

    // Tabs and closes reach the same states.
    const actions: WorkspaceAction[] = [
        { type: 'tab', id: 'properties' },
        { type: 'tab', id: 'history' },
        { type: 'close', id: 'groups' },
        { type: 'show', id: 'groups' },
        { type: 'toggleDock', side: 'left' },
        { type: 'toggleDock', side: 'left' },
    ]
    const start: WorkspaceToggleState = {
        open: { preview: true, groups: true, stages: true, properties: false, history: false },
        recency: ['preview', 'groups', 'stages', 'properties', 'history'],
        collapsed: unfolded,
    }
    const screen = {
        width: 2560,
        height: 900,
        positions: positions('left'),
        sizes: { left: 760, right: 0, top: 0 },
    }
    assert.deepEqual(
        play({ ...screen, groupsStagesSideBySide: 'enabled' }, start, actions),
        play({ ...screen, groupsStagesSideBySide: 'disabled' }, start, actions),
    )
})

test('the row of Groups and Stages stacks as one tile', () => {
    const left = computeWorkspaceLayout(sideBySide()).docks.left
    const sizes = tileSizes(left)
    assert.equal(sizes.groups, sizes.stages)
    // One separator below Preview, and one between the managers across the dock.
    assert.ok(Math.abs((sizes.preview ?? 0) + (sizes.groups ?? 0) + separatorSize - 1440) < 1e-6)
    assert.equal(
        (left?.sideBySide?.groups ?? 0) + separatorSize + (left?.sideBySide?.stages ?? 0),
        760,
    )
    // Below them, Properties stacks as usual.
    const below = computeWorkspaceLayout(sideBySide({ positions: positions('left') })).docks.left
    const stack = tileSizes(below)
    assert.deepEqual(below?.visible, ['preview', 'groups', 'stages', 'properties'])
    const total =
        (stack.preview ?? 0) + (stack.groups ?? 0) + (stack.properties ?? 0) + 2 * separatorSize
    assert.ok(Math.abs(total - 1440) < 1e-6)
    // The row keeps one manager's minimum, not both stacked.
    const squeezed = tileSizes(
        computeWorkspaceLayout(sideBySide({ height: 700, weights: { preview: 10 } })).docks.left,
    )
    assert.equal(squeezed.groups, 226)
    assert.equal(squeezed.preview, 700 - separatorSize - 226)
    // The row weighs as much as both managers.
    const weighted = tileSizes(
        computeWorkspaceLayout(sideBySide({ weights: { preview: 2, groups: 1, stages: 3 } })).docks
            .left,
    )
    assert.ok(Math.abs((weighted.preview ?? 0) - (2 / 6) * (1440 - separatorSize)) < 1e-6)
})

test("Groups' width follows its share, kept clear of both minimums for display", () => {
    const at = (groupsShare: number | undefined, left = 760) =>
        computeWorkspaceLayout(sideBySide({ groupsShare, sizes: { left, right: 0, top: 0 } })).docks
            .left
    assert.deepEqual(at(0.6)?.sideBySide, { groups: 454, stages: 302, min: 260, max: 496 })
    assert.equal(at(0.1)?.sideBySide?.groups, 260)
    assert.equal(at(0.9)?.sideBySide?.stages, 260)
    assert.equal(at(undefined)?.sideBySide?.groups, 378)
    // The widths leave the heights alone.
    assert.deepEqual(tileSizes(at(0.6)), tileSizes(at(0.5)))
})

test('a separator beside the row resizes it as one and keeps the managers in proportion', () => {
    const base = sideBySide({ positions: positions('left'), weights: { groups: 1, stages: 3 } })
    const tiles = computeWorkspaceLayout(base).docks.left?.tiles ?? []
    const tile = (id: PanelId) => tiles.find((each) => each.id === id)!
    const [preview, groups, stages, properties] = [
        tile('preview'),
        tile('groups'),
        tile('stages'),
        tile('properties'),
    ]
    const resized = (weights: Partial<Record<PanelId, number>>) =>
        tileSizes(
            computeWorkspaceLayout({ ...base, weights: { ...base.weights, ...weights } }).docks
                .left,
        )

    const above = resizeTileUnits([preview], [groups, stages], preview.size + 100)
    assert.ok(Math.abs((above.stages ?? 0) / (above.groups ?? 1) - 3) < 1e-9)
    const before = preview.weight + groups.weight + stages.weight
    const after = (above.preview ?? 0) + (above.groups ?? 0) + (above.stages ?? 0)
    assert.ok(Math.abs(after - before) < 1e-9)
    assert.ok(Math.abs((resized(above).preview ?? 0) - (preview.size + 100)) < 1e-6)
    assert.ok(Math.abs((resized(above).properties ?? 0) - properties.size) < 1e-6)

    const below = resizeTileUnits([groups, stages], [properties], groups.size - 50)
    assert.ok(Math.abs((below.stages ?? 0) / (below.groups ?? 1) - 3) < 1e-9)
    assert.equal(below.preview, undefined)
    assert.ok(Math.abs((resized(below).stages ?? 0) - (groups.size - 50)) < 1e-6)
})

test('Preview keeps its height when the managers move side by side', () => {
    const preview = (
        groupsStagesSideBySide: SideBySideChoice,
        overrides: Partial<WorkspaceLayoutInput>,
    ) =>
        tileSizes(
            computeWorkspaceLayout(sideBySide({ ...overrides, groupsStagesSideBySide })).docks.left,
        ).preview ?? 0
    for (const [choice, overrides] of [
        ['enabled', {}],
        ['enabled', { sizes: { left: 540, right: 0, top: 0 } }],
        ['enabled', { width: 1920, height: 1080 }],
        ['enabled', { weights: { preview: 3 } }],
        ['auto', { sizes: { left: 800, right: 0, top: 0 } }],
    ] as const) {
        assert.ok(
            computeWorkspaceLayout(sideBySide({ ...overrides, groupsStagesSideBySide: choice }))
                .docks.left?.sideBySide,
        )
        const change = Math.abs(preview(choice, overrides) - preview('disabled', overrides))
        assert.ok(change <= separatorSize, `${choice} ${JSON.stringify(overrides)}: ${change}`)
    }
    assert.ok(Math.abs(preview('enabled', {}) - (760 / (16 / 9) + 52)) < 1e-6)
})

test('the managers side by side never change which panels open by default', () => {
    const room = (overrides: Partial<WorkspaceLayoutInput>) => {
        const screen = input({ positions: positions('auto'), ...overrides })
        const room = (choice: SideBySideChoice) =>
            hasRoomFor({ ...screen, groupsStagesSideBySide: choice }, ['groups', 'stages'])
        for (const choice of ['auto', 'enabled'] as const)
            assert.equal(room(choice), room('disabled'), `${choice} ${JSON.stringify(overrides)}`)
        return room('disabled')
    }
    // Large text gives a 576 px default dock, where the stacked managers leave Preview short.
    const large = { rootFontSize: 24, toolbarWidth: oneRowToolbarWidth(defaultTools, 24, false) }
    assert.ok(!room({ width: 2560, height: 760, ...large }))
    assert.ok(room({ width: 2560, height: 1000, ...large }))
    assert.ok(room({ width: 2560, height: 1440 }))
    assert.ok(!room({ width: 1280, height: 600 }))
})
