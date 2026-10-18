import assert from 'node:assert/strict'
import test from 'node:test'
import { oneRowToolbarWidth } from '../../src/editor/toolbar/layout'
import {
    carryAcrossShape,
    computeWorkspaceLayout,
    reduceTransient,
    reduceWorkspace,
    resolveAutoSide,
    transientState,
    withoutTransient,
    type PanelId,
    type PanelPosition,
    type Transient,
    type WorkspaceLayoutInput,
    type WorkspaceToggleState,
} from '../../src/editor/workspace/layout'

// History is a layer over the saved workspace (Part 1 §1.4.10.4): the layout shows the normal
// `show` action applied for it, and nothing it displaces is closed for good.

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
    toolbarWidth: oneRowToolbarWidth(18, 16, false),
    ...overrides,
})

const phone = (overrides: Partial<WorkspaceLayoutInput> = {}) =>
    input({ width: 390, height: 844, ...overrides })

const history: Transient = { id: 'history', folds: {} }

const stateOf = (value: WorkspaceLayoutInput): WorkspaceToggleState => ({
    open: { ...value.open },
    recency: [...value.recency],
    collapsed: { left: false, right: false, top: false, ...value.collapsed },
})

/** The layout input for a saved state and an optional layer, as the workspace builds it. */
const inputOf =
    (base: WorkspaceLayoutInput) => (state: WorkspaceToggleState, transient?: Transient) => ({
        ...base,
        ...state,
        ...(transient ? { transient } : {}),
    })

const withLayer = (value: WorkspaceLayoutInput) =>
    computeWorkspaceLayout({ ...value, transient: history })

test('History has no tab until it is open, and a dock holding only it appears with it', () => {
    const closed = computeWorkspaceLayout(phone({ open: { ...phone().open, properties: false } }))
    assert.equal(closed.sides.history, undefined)
    assert.ok(!closed.docks.top?.panels.includes('history'))
    // Every other panel on the left: the top dock exists only for History.
    const positions: Record<PanelId, PanelPosition> = {
        preview: 'left',
        groups: 'left',
        stages: 'left',
        properties: 'left',
        history: 'top',
    }
    const wide = input({ positions })
    assert.equal(computeWorkspaceLayout(wide).docks.top, undefined)
    assert.deepEqual(withLayer(wide).docks.top?.panels, ['history'])
})

test('its tab is last in the rail, and it sits right of the editor beside Properties on a desktop', () => {
    const layout = withLayer(input())
    assert.equal(resolveAutoSide(1600, 1000, 'history'), 'right')
    assert.deepEqual(layout.docks.right?.panels, ['properties', 'history'])
    assert.deepEqual(layout.docks.right?.visible, ['properties', 'history'])
    // Nothing is displaced and the busier left dock is as it was.
    assert.deepEqual(layout.docks.left, computeWorkspaceLayout(input()).docks.left)
    assert.deepEqual(layout.docks.top, undefined)
})

test('on a phone it displaces the visible panel and the saved workspace is untouched', () => {
    const base = phone({
        open: { preview: true, groups: false, stages: false, properties: false, history: false },
    })
    const before = JSON.stringify(base)
    const layout = withLayer(base)
    assert.deepEqual(layout.docks.top?.visible, ['history'])
    // Preview was closed in the layer only.
    const shown = transientState({ ...base, transient: history })
    assert.equal(shown?.open.preview, false)
    assert.equal(shown?.open.history, true)
    assert.equal(JSON.stringify(base), before)
})

test('open then close round-trips the layout exactly', () => {
    for (const base of [phone(), input(), input({ width: 820, height: 1180 })]) {
        const before = computeWorkspaceLayout(base)
        withLayer(base)
        assert.deepEqual(computeWorkspaceLayout(base), before)
        assert.equal(computeWorkspaceLayout(base).sides.history, undefined)
    }
})

test('a tab on Preview while History covers it saves Preview open and closes History', () => {
    const base = phone({
        open: { preview: true, groups: false, stages: false, properties: false, history: false },
    })
    const saved = stateOf(base)
    const result = reduceTransient(saved, history, { type: 'tab', id: 'preview' }, inputOf(base))
    // What History had displaced is committed closed, then the tap opens it; History has no room.
    assert.equal(result.saved.open.preview, true)
    assert.equal(result.saved.open.history, false)
    assert.equal(result.transient, undefined)
})

test('an action mid-visit saves what is on screen, and History stays when it has room', () => {
    const base = input()
    const saved = stateOf(base)
    const result = reduceTransient(saved, history, { type: 'show', id: 'groups' }, inputOf(base))
    assert.equal(result.saved.open.groups, true)
    assert.deepEqual(result.saved.open.history, false)
    assert.ok(!result.saved.recency.includes('history'))
    assert.equal(result.transient?.id, 'history')
    // The left dock is committed as it showed.
    const layout = computeWorkspaceLayout({
        ...inputOf(base)(result.saved),
        transient: result.transient,
    })
    assert.deepEqual(layout.docks.left?.visible, ['preview', 'groups'])
    assert.ok(layout.docks.right?.visible.includes('history'))
})

test('what History displaced is saved closed once another action is taken', () => {
    // Phone: Properties and Preview open, History covers both.
    const base = phone({
        open: { preview: true, groups: true, stages: false, properties: true, history: false },
    })
    const saved = stateOf(base)
    const shown = transientState({ ...base, transient: history })
    assert.ok(shown)
    const displaced = (['preview', 'groups', 'properties'] as const).filter((id) => !shown.open[id])
    assert.ok(displaced.length > 0)
    const result = reduceTransient(saved, history, { type: 'close', id: 'groups' }, inputOf(base))
    for (const id of displaced) assert.equal(result.saved.open[id], false)
})

test('folding History’s dock is part of the layer and saves nothing', () => {
    const base = input()
    const saved = stateOf(base)
    const folded = reduceTransient(
        saved,
        history,
        { type: 'toggleDock', side: 'right' },
        inputOf(base),
    )
    assert.equal(folded.saved, saved)
    assert.equal(folded.transient?.folds.right, true)
    const layout = computeWorkspaceLayout({ ...base, transient: folded.transient })
    // The tab stays on the folded rail, and the peek bar has the canvas to itself.
    assert.equal(layout.docks.right?.collapsed, true)
    assert.ok(layout.docks.right?.panels.includes('history'))
    // The chevron again unfolds it.
    const unfolded = reduceTransient(
        saved,
        folded.transient ?? history,
        { type: 'toggleDock', side: 'right' },
        inputOf(base),
    )
    assert.equal(unfolded.saved, saved)
    assert.equal(unfolded.transient?.folds.right, false)
})

test('a tab on History folds its dock when it is the only panel there, else closes it', () => {
    const base = phone({
        open: { preview: false, groups: false, stages: false, properties: false, history: false },
    })
    const saved = stateOf(base)
    const alone = reduceTransient(saved, history, { type: 'tab', id: 'history' }, inputOf(base))
    assert.equal(alone.saved, saved)
    assert.equal(alone.transient?.folds.top, true)
    // Beside another panel on a tablet, the tab closes it like any tab.
    const tablet = input({
        width: 1024,
        height: 1366,
        open: { ...input().open, preview: true, properties: false },
    })
    const beside = reduceTransient(
        stateOf(tablet),
        history,
        { type: 'tab', id: 'history' },
        inputOf(tablet),
    )
    assert.equal(beside.transient, undefined)
    assert.deepEqual(beside.saved.open, stateOf(tablet).open)
})

test('closing History drops the layer and the saved state is what it was', () => {
    const base = phone()
    const saved = stateOf(base)
    const result = reduceTransient(saved, history, { type: 'close', id: 'history' }, inputOf(base))
    assert.equal(result.transient, undefined)
    assert.equal(result.saved, saved)
})

test('a reload starts without the layer: the saved state alone gives the layout', () => {
    const base = phone()
    assert.deepEqual(
        withoutTransient(transientState({ ...base, transient: history }) as WorkspaceToggleState)
            .recency,
        base.recency,
    )
    assert.equal(computeWorkspaceLayout(base).sides.history, undefined)
})

test('rotating moves History with the other Auto panels without saving its displacement', () => {
    // A tablet in portrait, then landscape: Auto panels move from the top dock to the left.
    const portrait = input({
        width: 820,
        height: 1180,
        open: { preview: true, groups: true, stages: false, properties: false, history: false },
    })
    const landscape = { ...portrait, width: 1180, height: 820 }
    const saved = stateOf(portrait)
    const before = computeWorkspaceLayout(portrait)
    const after = computeWorkspaceLayout(landscape)
    // The shape change is judged against the saved workspace, with no layer in it.
    const carried = carryAcrossShape(before, after, saved)
    assert.equal(carried.open.history, false)
    const layer = computeWorkspaceLayout({ ...landscape, ...carried, transient: history })
    assert.equal(layer.sides.history, 'right')
    assert.ok(layer.docks.right?.visible.includes('history'))
    // Nothing the layer displaced was saved by the rotation.
    assert.deepEqual(carried.open, carryAcrossShape(before, after, saved).open)
})

test('opening History on a side makes it the shown side, and closing it brings the other back', () => {
    // Too narrow for both side bodies: only the side with the most recent panel shows.
    const base = input({
        width: 700,
        height: 600,
        positions: {
            preview: 'left',
            groups: 'left',
            stages: 'left',
            properties: 'right',
            history: 'left',
        },
        recency: ['properties', 'preview', 'groups', 'stages'],
    })
    const plain = computeWorkspaceLayout(base)
    assert.equal(plain.docks.right?.suppressed, false)
    assert.equal(plain.docks.left?.suppressed, true)
    const layer = withLayer(base)
    assert.equal(layer.docks.left?.suppressed, false)
    // The other side's body is hidden in the layer only.
    assert.deepEqual(layer.docks.right?.visible, [])
    assert.deepEqual(computeWorkspaceLayout(base), plain)
    assert.deepEqual(plain.docks.right?.visible, ['properties'])
})

test('a side dock too narrow to sit beside the editor shows History as a drawer', () => {
    const base = input({
        width: 400,
        height: 300,
        positions: {
            preview: 'left',
            groups: 'left',
            stages: 'left',
            properties: 'left',
            history: 'left',
        },
        open: { preview: false, groups: false, stages: false, properties: false, history: false },
    })
    const layer = withLayer(base)
    assert.equal(layer.docks.left?.overlay, true)
    assert.deepEqual(layer.docks.left?.visible, ['history'])
    assert.equal(computeWorkspaceLayout(base).docks.left?.visible.length, 0)
})

test('History’s minimums are 240 tall and 280 wide', () => {
    const side = computeWorkspaceLayout({
        ...input({ width: 1400, height: 700 }),
        positions: {
            preview: 'left',
            groups: 'left',
            stages: 'left',
            properties: 'left',
            history: 'left',
        },
        open: { preview: true, groups: true, stages: true, properties: true, history: false },
        transient: history,
    })
    const tile = side.docks.left?.tiles.find((other) => other.id === 'history')
    assert.equal(tile?.min, 240)
    const top = withLayer(phone())
    assert.equal(top.docks.top?.tiles.find((other) => other.id === 'history')?.min, 280)
})

test('reduceWorkspace on a state with History open treats it like any panel', () => {
    const base = phone({
        open: { preview: true, groups: false, stages: false, properties: false, history: true },
    })
    const state = stateOf(base)
    const next = reduceWorkspace(state, { type: 'show', id: 'preview' }, (s) =>
        computeWorkspaceLayout({ ...base, ...s }),
    )
    assert.equal(next.open.preview, true)
    assert.equal(next.open.history, false)
})
