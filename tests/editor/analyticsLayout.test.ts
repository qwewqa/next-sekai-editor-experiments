import assert from 'node:assert/strict'
import test from 'node:test'
import { catalogue, isValidEvent, MAX_KEYS, SECONDS_CAP } from '../../src/analytics/catalogue'
import { createLayoutTime, layoutKeys } from '../../src/analytics/layoutTime'
import {
    computeWorkspaceLayout,
    panelIds,
    type PanelId,
    type PanelPosition,
    type WorkspaceLayoutInput,
} from '../../src/editor/workspace/layout'

// The `layout` event's accounting, driven with real workspace layouts and a fake clock.

const positions = (position: PanelPosition): Record<PanelId, PanelPosition> => ({
    preview: position,
    groups: position,
    stages: position,
    properties: position,
    history: position,
})
const closed = { preview: false, groups: false, stages: false, properties: false, history: false }

const input = (overrides: Partial<WorkspaceLayoutInput> = {}): WorkspaceLayoutInput => ({
    width: 1600,
    height: 1000,
    positions: positions('auto'),
    open: { ...closed, preview: true, properties: true },
    recency: ['preview', 'properties', 'groups', 'stages'],
    sizes: { left: 0, right: 0, top: 0 },
    weights: {},
    previewAspectRatio: 16 / 9,
    toolbarWidth: 700,
    ...overrides,
})

const keysOf = (overrides: Partial<WorkspaceLayoutInput> = {}) => {
    const layout = input(overrides)
    return layoutKeys(computeWorkspaceLayout(layout), layout)
}

/** Preview alone on the left, at a width. */
const previewOnLeft = (left: number) =>
    keysOf({
        positions: { ...positions('disabled'), preview: 'left' },
        open: { ...closed, preview: true },
        sizes: { left, right: 0, top: 0 },
    })

// Preview, Groups and Stages on the left of a wide screen, Properties on the right.
const wide: Partial<WorkspaceLayoutInput> = {
    width: 2560,
    height: 1440,
    positions: { ...positions('right'), preview: 'left', groups: 'left', stages: 'left' },
    open: { ...closed, preview: true, groups: true, stages: true, properties: true },
    recency: ['preview', 'groups', 'stages', 'properties', 'history'],
    sizes: { left: 760, right: 0, top: 0 },
    groupsStagesSideBySide: true,
}

test('a panel counts on the side where it is shown, with that side at its size and Preview at its share', () => {
    assert.deepEqual(keysOf(), [
        'panelSeconds.preview.left',
        'dockSizeSeconds.left.280-400',
        'previewShareSeconds.10-25',
        'panelSeconds.properties.right',
        'dockSizeSeconds.right.280-400',
    ])
    // Properties alone has no Preview share.
    assert.ok(
        !keysOf({ open: { ...closed, properties: true } }).some((key) =>
            key.startsWith('previewShareSeconds'),
        ),
    )
})

test('a size on a range edge is in the range above it', () => {
    assert.deepEqual(previewOnLeft(279), [
        'panelSeconds.preview.left',
        'dockSizeSeconds.left.0-280',
        'previewShareSeconds.10-25',
    ])
    // 399 and 400 px of 1600 px: Preview's tile spans the 1000 px height, so 400 px is 25%.
    assert.ok(previewOnLeft(399).includes('dockSizeSeconds.left.280-400'))
    assert.ok(previewOnLeft(399).includes('previewShareSeconds.10-25'))
    assert.ok(previewOnLeft(400).includes('dockSizeSeconds.left.400-540'))
    assert.ok(previewOnLeft(400).includes('previewShareSeconds.25-50'))
    assert.ok(previewOnLeft(540).includes('dockSizeSeconds.left.540-760'))
    assert.ok(previewOnLeft(760).includes('dockSizeSeconds.left.760+'))
})

test('the top dock counts by its height, and Preview by its tile in the row', () => {
    const keys = keysOf({
        width: 1000,
        height: 700,
        positions: { ...positions('disabled'), preview: 'top', properties: 'top' },
    })
    assert.deepEqual(
        keys.filter((key) => !key.startsWith('previewShareSeconds')),
        ['panelSeconds.preview.top', 'panelSeconds.properties.top', 'dockSizeSeconds.top.0-280'],
    )
    const share = keys.find((key) => key.startsWith('previewShareSeconds'))
    assert.ok(share, 'a share of the workspace')
})

test('open panels that do not fit are covered; a folded dock covers nothing', () => {
    const crowded = {
        width: 1600,
        height: 500,
        positions: positions('left'),
        open: { preview: true, groups: true, stages: true, properties: true, history: true },
        recency: panelIds,
    }
    const keys = keysOf(crowded)
    assert.deepEqual(
        keys.filter((key) => key.endsWith('.covered')),
        [
            'panelSeconds.stages.covered',
            'panelSeconds.properties.covered',
            'panelSeconds.history.covered',
        ],
    )
    assert.ok(keys.includes('panelSeconds.preview.left'))
    assert.ok(keys.includes('panelSeconds.groups.left'))
    const folded = keysOf({ ...crowded, collapsed: { left: true } })
    assert.deepEqual(folded, ['collapsedSeconds'])
})

test('a dock folded by the user is collapsed, and one folded by the editor is suppressed', () => {
    // Both sides are open, and the room beside the chart is enough for one.
    const both = {
        width: 800,
        height: 700,
        positions: { ...positions('disabled'), preview: 'left', properties: 'right' },
        recency: ['preview', 'properties'] as PanelId[],
    } satisfies Partial<WorkspaceLayoutInput>
    const automatic = keysOf(both)
    assert.ok(automatic.includes('suppressedSeconds'))
    assert.ok(!automatic.includes('collapsedSeconds'))
    assert.ok(automatic.includes('panelSeconds.preview.left'))
    assert.ok(!automatic.some((key) => key.startsWith('panelSeconds.properties')))

    const chosen = keysOf({ ...both, collapsed: { right: true } })
    assert.ok(chosen.includes('collapsedSeconds'))
    assert.ok(!chosen.includes('suppressedSeconds'))

    // Folding the side that is shown leaves nothing shown on that side.
    const hidden = keysOf({ ...both, collapsed: { left: true } })
    assert.ok(hidden.includes('collapsedSeconds'))
    assert.ok(!hidden.some((key) => key.startsWith('panelSeconds.preview')))
})

test('a drawer over the chart counts as shown, at the drawer width', () => {
    const keys = keysOf({
        width: 390,
        height: 844,
        positions: positions('right'),
        open: { ...closed, preview: true, properties: true },
    })
    assert.ok(keys.includes('drawerSeconds'))
    assert.ok(keys.includes('panelSeconds.preview.right'))
    assert.ok(keys.some((key) => key.startsWith('dockSizeSeconds.right.')))
    assert.ok(!keysOf().includes('drawerSeconds'))
})

test('Groups and Stages count as paired only while shown side by side', () => {
    assert.ok(keysOf(wide).includes('pairedSeconds'))
    assert.ok(!keysOf({ ...wide, groupsStagesSideBySide: false }).includes('pairedSeconds'))
    assert.ok(
        !keysOf({ ...wide, sizes: { left: 539, right: 0, top: 0 } }).includes('pairedSeconds'),
    )
    // The panels are shown either way.
    assert.ok(
        keysOf({ ...wide, groupsStagesSideBySide: false }).includes('panelSeconds.groups.left'),
    )
})

test('every counter a layout adds time to is a property of the event', () => {
    const everything = Object.keys(catalogue.layout)
    const found = new Set<string>()
    for (const width of [390, 820, 1280, 1600, 2560])
        for (const height of [500, 844, 1000])
            for (const position of ['auto', 'left', 'right', 'top'] as const)
                for (const collapsed of [false, true])
                    for (const side of [false, true]) {
                        const keys = keysOf({
                            width,
                            height,
                            positions: positions(position),
                            open: {
                                preview: true,
                                groups: true,
                                stages: true,
                                properties: true,
                                history: true,
                            },
                            recency: panelIds,
                            collapsed: { left: collapsed, right: collapsed, top: collapsed },
                            groupsStagesSideBySide: side,
                            sizes: { left: 900, right: 0, top: 0 },
                        })
                        for (const key of keys) {
                            assert.ok(everything.includes(key), key)
                            found.add(key)
                        }
                    }
    assert.ok(found.size > 20)
})

// A clock the tests move by hand.
const clock = () => {
    const time = { ms: 0 }
    return { time, now: () => time.ms }
}

const left = ['panelSeconds.preview.left', 'dockSizeSeconds.left.280-400']
const top = ['panelSeconds.preview.top', 'dockSizeSeconds.top.0-280']

test('a change of side divides the time between the sides', () => {
    const { time, now } = clock()
    const layout = createLayoutTime(now, true, left)
    time.ms = 40_000
    layout.change(top)
    time.ms = 60_000
    assert.deepEqual(layout.take(), {
        visibleTime: 60,
        'panelSeconds.preview.left': 40,
        'dockSizeSeconds.left.280-400': 40,
        'panelSeconds.preview.top': 20,
        'dockSizeSeconds.top.0-280': 20,
    })
})

test('a resize across a range edge divides the time between the two ranges', () => {
    const { time, now } = clock()
    const at = (width: number) => previewOnLeft(width)
    const layout = createLayoutTime(now, true, at(380))
    time.ms = 10_000
    layout.change(at(380))
    time.ms = 30_000
    // The drag crosses 400 px.
    layout.change(at(420))
    time.ms = 35_000
    const data = layout.take()
    assert.equal(data?.['dockSizeSeconds.left.280-400'], 30)
    assert.equal(data?.['dockSizeSeconds.left.400-540'], 5)
    assert.equal(data?.['previewShareSeconds.10-25'], 30)
    assert.equal(data?.['previewShareSeconds.25-50'], 5)
    assert.equal(data?.['panelSeconds.preview.left'], 35)
    assert.equal(data?.visibleTime, 35)
})

test('time while the page is hidden is not counted, whatever changes meanwhile', () => {
    const { time, now } = clock()
    const layout = createLayoutTime(now, true, left)
    time.ms = 10_000
    layout.visibility(false)
    time.ms = 20_000
    layout.change(top)
    time.ms = 50_000
    layout.visibility(true)
    time.ms = 60_000
    assert.deepEqual(layout.take(), {
        visibleTime: 20,
        'panelSeconds.preview.left': 10,
        'dockSizeSeconds.left.280-400': 10,
        'panelSeconds.preview.top': 10,
        'dockSizeSeconds.top.0-280': 10,
    })
    // A page that starts hidden has no time until it is shown.
    const later = createLayoutTime(now, false, left)
    time.ms = 90_000
    assert.equal(later.take(), undefined)
    later.visibility(true)
    time.ms = 93_000
    assert.deepEqual(later.take(), {
        visibleTime: 3,
        'panelSeconds.preview.left': 3,
        'dockSizeSeconds.left.280-400': 3,
    })
})

test('the part of a second left over carries to the next send, for each counter', () => {
    const { time, now } = clock()
    const layout = createLayoutTime(now, true, left)
    const sent: Record<string, number> = {}
    const send = () => {
        for (const [key, value] of Object.entries(layout.take() ?? {}))
            sent[key] = (sent[key] ?? 0) + value
    }
    // Four stretches of 400 ms on the left, then 300, 200 and 500 ms on the top, each followed by a send.
    for (let i = 0; i < 4; i++) {
        time.ms += 400
        send()
    }
    layout.change(top)
    time.ms += 300
    send()
    time.ms += 200
    send()
    time.ms += 500
    send()
    // 2.6 s visible: the left had 1.6 s and the top 1 s.
    assert.equal(sent.visibleTime, 3)
    assert.equal(sent['panelSeconds.preview.left'], 2)
    assert.equal(sent['panelSeconds.preview.top'], 1)
})

test('a counter keeps the part of a second it did not send', () => {
    const { time, now } = clock()
    const layout = createLayoutTime(now, true, left)
    time.ms = 1_400
    assert.equal(layout.take()?.['panelSeconds.preview.left'], 1)
    // The 0.4 s left over and 0.1 s more make half a second, which rounds up.
    time.ms = 1_500
    assert.equal(layout.take()?.['panelSeconds.preview.left'], 1)
})

test('nothing goes below a second, and the time stays for the next send', () => {
    const { time, now } = clock()
    const layout = createLayoutTime(now, true, left)
    time.ms = 400
    assert.equal(layout.take(), undefined)
    time.ms = 1_000
    assert.deepEqual(layout.take(), {
        visibleTime: 1,
        'panelSeconds.preview.left': 1,
        'dockSizeSeconds.left.280-400': 1,
    })
    assert.equal(layout.take(), undefined)
})

test('a counter under half a second is left out, not sent as zero', () => {
    const { time, now } = clock()
    const layout = createLayoutTime(now, true, left)
    time.ms = 9_800
    layout.change(top)
    time.ms = 10_000
    const data = layout.take()
    assert.equal(data?.visibleTime, 10)
    assert.ok(data && !('panelSeconds.preview.top' in data))
    assert.ok(data && Object.values(data).every((value) => value > 0))
})

test('a counter is capped at a day, and the rest stays', () => {
    const { time, now } = clock()
    const layout = createLayoutTime(now, true, left)
    time.ms = (SECONDS_CAP + 5) * 1000
    assert.equal(layout.take()?.visibleTime, SECONDS_CAP)
    assert.equal(layout.take()?.visibleTime, 5)
})

test('the event has 44 properties, under the key limit, and the full event is valid and small', () => {
    const keys = Object.keys(catalogue.layout)
    assert.equal(keys.length, 44)
    assert.ok(keys.length <= MAX_KEYS)
    const full = Object.fromEntries(keys.map((key) => [key, SECONDS_CAP]))
    assert.ok(isValidEvent('layout', full))
    assert.ok(!isValidEvent('layout', { ...full, extra: 1 }))
    assert.ok(isValidEvent('layout', { 'dockSizeSeconds.left.0-280': 1 }))
    assert.ok(!isValidEvent('layout', { visibleTime: SECONDS_CAP + 1 }))
    assert.ok(!isValidEvent('layout', { visibleTime: 1.5 }))
    // Sent whole, it is a small request.
    assert.ok(JSON.stringify(full).length < 2_500)
})
