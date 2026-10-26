import { expect, test, type JSHandle, type Page } from '@playwright/test'
import type { Chart } from '../../src/chart'
import type { State } from '../../src/state'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// The hover highlights exactly what a tap there would act on. Each test plays hundreds of hover and tap
// rounds, so each round takes few round trips.
test.describe.configure({ timeout: 90_000 })

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

// Three overlapping notes, one beside them in reach, and markers among them; 40 px a lane.
const showStack = (page: Page) =>
    page.evaluate(() => {
        const { show, fixtures, view, settings } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        const events = fixtures.events
        const chart: Chart = {
            ...events,
            isDynamicStages: true,
            bpms: [{ beat: 0, bpm: 120 }],
            cameraEvents: [],
            stageMaskEvents: [],
            stagePivotEvents: [{ ...events.stagePivotEvents[0]!, beat: 4, pivotLane: -1 }],
            stageStyleEvents: [],
            stageTransformEvents: [],
            timeScales: [
                {
                    ...events.timeScales[0]!,
                    groupId: base.groupId,
                    beat: 4,
                    editorLane: 1.5,
                    hideNotes: false,
                },
            ],
            slides: [
                [{ ...base, beat: 4, left: -2, size: 3 }],
                [{ ...base, beat: 4, left: -1, size: 3 }],
                [{ ...base, beat: 4.05, left: 0, size: 2 }],
                [{ ...base, beat: 4, left: 2.3, size: 1 }],
            ],
        }
        show(chart, 2)
        settings.width = view.w / 40
        settings.pps = 160
        view.lane = 0
    })

type Which = 'none' | 'inStack' | 'outside'
type Point = { x: number; y: number }
type Baseline = JSHandle<State>

const baseline = (page: Page) => page.evaluateHandle(() => window.editorTest.history.state.value)

const read = async (
    page: Page,
    options: { of?: 'hovered' | 'selected'; which?: Which; tool?: string; initial?: Baseline },
) => {
    const result = await page.evaluate(async ({ of, which, tool, initial }) => {
        const { view, history, appImport } = window.editorTest
        if (tool) {
            const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
                '/src/editor/tools/index.ts',
            )
            switchToolTo(tool as never)
        }
        const state = history.state.value
        const list = of === 'hovered' ? view.entities.hovered : state.selectedEntities
        const result = {
            keys: list
                .map(
                    (entity) =>
                        `${entity.type}:${entity.beat}:${'left' in entity ? entity.left : ''}`,
                )
                .sort(),
            unedited:
                !initial ||
                (state.store === initial.store &&
                    state.bpms === initial.bpms &&
                    state.groups === initial.groups &&
                    state.stages === initial.stages &&
                    state.groupFolders === initial.groupFolders &&
                    state.stageFolders === initial.stageFolders &&
                    state.isDynamicStages === initial.isDynamicStages),
            canUndo: history.canUndo.value,
            pristine: history.isPristine.value,
        }
        if (which) {
            const notes = [...state.store.slides.note.values()].flat()
            history.replaceState({
                ...state,
                selectedEntities:
                    which === 'none'
                        ? []
                        : notes.filter((note) => note.left === (which === 'inStack' ? -1 : 2.3)),
            })
        }
        return result
    }, options)
    if (options.initial)
        expect(result, 'hover and selection preserve chart data and undo history').toMatchObject({
            unedited: true,
            canUndo: false,
            pristine: true,
        })
    return result.keys
}

const keys = (page: Page, of: 'hovered' | 'selected', initial?: Baseline) =>
    read(page, { of, initial })

const originalPoints = (page: Page) =>
    page.evaluate(() => {
        const result = []
        for (let lane = -2.5; lane <= 3.5; lane += 0.35)
            for (const beat of [3.9, 3.97, 4, 4.03, 4.08, 4.12])
                result.push(window.editorTest.point(lane, beat))
        return result
    })

const points = (page: Page) =>
    page.evaluate(() => {
        const { point } = window.editorTest
        const result: { name: string; x: number; y: number; expected?: string[] }[] = []
        const add = (name: string, lane: number, beat = 4, dx = 0, dy = 0, expected?: string[]) => {
            const at = point(lane, beat)
            result.push({ name, x: Math.round(at.x + dx), y: Math.round(at.y + dy), expected })
        }
        // Round full CSS points so Firefox dispatches either side of each boundary.
        for (let lane = -2.5; lane <= 3.5; lane += 0.35) add(`horizontal ${lane}`, lane)
        for (const [name, lane] of [
            ['first left', -2],
            ['first right', 1],
            ['second left', -1],
            ['second right', 2],
            ['third left', 0],
            ['narrow minimum left', 2.05],
            ['narrow minimum right', 3.55],
            ['outer left reach', -2.25],
            ['outer right reach', 3.8],
        ] as const)
            for (const dx of [-1, 1])
                add(
                    `${name} ${dx}`,
                    lane,
                    4,
                    dx,
                    0,
                    name === 'outer left reach'
                        ? dx < 0
                            ? []
                            : ['note:4:-2']
                        : name === 'outer right reach'
                          ? dx > 0
                              ? []
                              : ['note:4:2.3']
                          : undefined,
                )
        for (const dy of [-23, -21, 21, 23])
            add(`vertical reach ${dy}`, -1.7, 4, 0, dy, Math.abs(dy) === 23 ? [] : ['note:4:-2'])
        for (const dx of [-1, 1])
            add(`diagonal ${dx}`, -2.25, 4, dx, 21, dx < 0 ? [] : ['note:4:-2'])
        add('early interior', 0.5, 3.9)
        add('late interior', 0.5, 4.12)
        return result
    })

/** Switches to a tool if given and sets the selection; returns the selection it replaces, the last tap's. */
const select = (page: Page, which: Which, tool?: string, initial?: Baseline) =>
    read(page, { which, tool, initial })

const hoverAt = async (page: Page, point: { x: number; y: number }) => {
    await page.mouse.move(point.x - 1, point.y)
    await page.mouse.move(point.x, point.y)
}

const tapExpected = async (page: Page, point: Point, expected: string[], initial?: Baseline) => {
    await hoverAt(page, point)
    expect(await keys(page, 'hovered', initial), `hover at ${point.x},${point.y}`).toEqual(expected)
    await page.mouse.click(point.x, point.y)
    expect(await keys(page, 'selected', initial), `tap at ${point.x},${point.y}`).toEqual(expected)
}

const stackAnchors = (page: Page) =>
    page.evaluate(() => {
        const { point } = window.editorTest
        return {
            isolated: point(2.8, 4),
            overlap: point(0.5, 4),
            pivot: point(-0.975, 4),
            timeScale: point(1.5, 4),
            empty: point(-5, 4),
        }
    })

const stackNotes = ['note:4:-1', 'note:4:-2', 'note:4.05:0']

const recordHits = (seen: Set<string>, hovered: string[]) => {
    for (const key of hovered) seen.add(key)
    seen.add(hovered.length ? 'hit' : 'miss')
}

test('Select: the hover is what a tap selects, cycling, with or without a selection there', async ({
    page,
}) => {
    // Every point, tapped three ways.
    test.slow()
    await showStack(page)
    const initial = await baseline(page)
    await select(page, 'none', 'select')
    const anchors = await stackAnchors(page)
    await tapExpected(page, anchors.isolated, ['note:4:2.3'], initial)
    for (const [point, cycle] of [
        [anchors.overlap, stackNotes],
        [anchors.pivot, ['note:4:-1', 'note:4:-2', 'stagePivotEventJoint:4:']],
        [anchors.timeScale, ['note:4:-1', 'note:4.05:0', 'timeScale:4:']],
    ] as const) {
        await select(page, 'none')
        for (const expected of [...cycle, cycle[0]!]) {
            await tapExpected(page, point, [expected], initial)
        }
    }
    await select(page, 'outside')
    await tapExpected(page, anchors.empty, [], initial)
    const seen = new Set<string>()
    // Each tap's selection is read as the next round sets its own.
    let check: ((selected: string[]) => void) | undefined
    for (const point of await points(page)) {
        for (const which of ['none', 'inStack', 'outside'] as const) {
            check?.(await select(page, which, undefined, initial))
            await hoverAt(page, point)
            const hovered = await keys(page, 'hovered', initial)
            if (point.expected) expect(hovered, point.name).toEqual(point.expected)
            await page.mouse.click(point.x, point.y)
            check = (selected) =>
                expect(selected, `${which} ${point.name} at ${point.x},${point.y}`).toEqual(hovered)
            recordHits(seen, hovered)
        }
    }
    check?.(await keys(page, 'selected', initial))
    expect([...seen].sort()).toEqual([...stackNotes, 'note:4:2.3', 'hit', 'miss'].sort())
})

test('Select with Ctrl: the hover is every object a Ctrl-tap adds or removes', async ({ page }) => {
    await showStack(page)
    const initial = await baseline(page)
    await select(page, 'none', 'select')
    const anchors = await stackAnchors(page)
    const overlap = [...stackNotes].sort()
    const outside = ['note:4:2.3']
    await select(page, 'outside')
    await page.keyboard.down('Control')
    await hoverAt(page, anchors.overlap)
    expect(await keys(page, 'hovered', initial)).toEqual(overlap)
    await page.mouse.click(anchors.overlap.x, anchors.overlap.y)
    expect(await keys(page, 'selected', initial)).toEqual([...overlap, ...outside].sort())
    await hoverAt(page, anchors.overlap)
    expect(await keys(page, 'hovered', initial)).toEqual(overlap)
    await page.mouse.click(anchors.overlap.x, anchors.overlap.y)
    expect(await keys(page, 'selected', initial)).toEqual(outside)
    await hoverAt(page, anchors.empty)
    expect(await keys(page, 'hovered', initial)).toEqual([])
    await page.mouse.click(anchors.empty.x, anchors.empty.y)
    expect(await keys(page, 'selected', initial)).toEqual(outside)
    await select(page, 'inStack')
    await hoverAt(page, anchors.overlap)
    expect(await keys(page, 'hovered', initial)).toEqual(overlap)
    await page.mouse.click(anchors.overlap.x, anchors.overlap.y)
    expect(await keys(page, 'selected', initial)).toEqual(overlap)
    for (const [point, expected] of [
        [anchors.pivot, ['note:4:-1', 'note:4:-2', 'stagePivotEventJoint:4:']],
        [anchors.timeScale, ['note:4:-1', 'note:4.05:0', 'timeScale:4:']],
    ] as const) {
        await select(page, 'none')
        await hoverAt(page, point)
        expect(await keys(page, 'hovered', initial)).toEqual([...expected].sort())
        await page.mouse.click(point.x, point.y)
        expect(await keys(page, 'selected', initial)).toEqual([...expected].sort())
    }
    await page.keyboard.up('Control')
    const outcomes = new Set<string>()
    for (const point of (await originalPoints(page)).filter((_, i) => i % 3 === 0)) {
        await select(page, 'outside', undefined, initial)
        await page.keyboard.down('Control')
        await hoverAt(page, point)
        const hovered = await keys(page, 'hovered', initial)
        const before = await keys(page, 'selected', initial)
        await page.mouse.click(point.x, point.y)
        await page.keyboard.up('Control')
        const after = await keys(page, 'selected', initial)
        if (!hovered.length) {
            outcomes.add('miss')
            expect(after).toEqual(before)
            continue
        }
        const all = hovered.every((entity) => before.includes(entity))
        outcomes.add(all ? 'remove' : 'add')
        const expected = all
            ? before.filter((entity) => !hovered.includes(entity))
            : [...new Set([...before, ...hovered])].sort()
        expect(after, `at ${point.x},${point.y}`).toEqual(expected)
    }
    expect([...outcomes].sort()).toEqual(['add', 'miss', 'remove'])
})

/** The objects not in `all`, and those of `all` gone; undoes the tap if it changed any. Without `all`, every object. */
const changed = async (page: Page, all?: string[], initial?: Baseline) => {
    const result = await page.evaluate(
        ({ all, initial }) => {
            const { store, history } = window.editorTest
            const now = [...store.getAllEntities()]
                .filter((entity) => entity.type !== 'bpm' && !entity.type.startsWith('connector'))
                .map(
                    (entity) =>
                        `${entity.type}:${entity.beat}:${'left' in entity ? entity.left : ''}`,
                )
            const selected = history.state.value.selectedEntities
                .map(
                    (entity) =>
                        `${entity.type}:${entity.beat}:${'left' in entity ? entity.left : ''}`,
                )
                .sort()
            // As multisets: an add can repeat an object's beat and lane.
            const minus = (a: string[], b: string[]) => {
                const rest = [...b]
                return a.filter((name) => {
                    const i = rest.indexOf(name)
                    if (i >= 0) rest.splice(i, 1)
                    return i < 0
                })
            }
            const added = minus(now, all ?? []).sort()
            const removed = all ? minus(all, now) : []
            if (all && (added.length || removed.length)) history.undoState()
            const restored = [...store.getAllEntities()]
                .filter((entity) => entity.type !== 'bpm' && !entity.type.startsWith('connector'))
                .map(
                    (entity) =>
                        `${entity.type}:${entity.beat}:${'left' in entity ? entity.left : ''}`,
                )
                .sort()
            return {
                added,
                removed,
                selected,
                restored,
                sameStore: !initial || history.state.value.store === initial.store,
                canUndo: history.canUndo.value,
            }
        },
        { all, initial },
    )
    if (all) {
        expect(result.restored, 'undo restores the original entity multiset').toEqual(all)
        expect(result.sameStore, 'undo restores the exact original chart store').toBe(true)
        expect(result.canUndo, 'the action leaves no extra undo step').toBe(false)
    }
    return { added: result.added, removed: result.removed, selected: result.selected }
}

test('Eraser and Note tool: the hover is what a tap removes or selects, and the add ghost what it adds', async ({
    page,
}) => {
    // Hundreds of points, each read and tapped through the page.
    test.slow()
    await showStack(page)
    const initial = await baseline(page)
    const all = (await changed(page)).added
    const anchors = await stackAnchors(page)
    for (const [point, which, expected] of [
        [anchors.isolated, 'none', ['note:4:2.3']],
        [anchors.isolated, 'inStack', ['note:4:2.3']],
        [anchors.overlap, 'none', ['note:4:-1']],
        [anchors.overlap, 'inStack', ['note:4:-1']],
        [anchors.empty, 'inStack', []],
    ] as const) {
        await select(page, which, 'eraser')
        await hoverAt(page, point)
        expect(await keys(page, 'hovered')).toEqual([...expected])
        await page.mouse.click(point.x, point.y)
        const result = await changed(page, all, initial)
        expect(result.added).toEqual([])
        expect(result.removed).toEqual([...expected])
    }
    await select(page, 'none', 'note')
    await tapExpected(page, anchors.isolated, ['note:4:2.3'])
    expect(await changed(page, all, initial)).toEqual({
        added: [],
        removed: [],
        selected: ['note:4:2.3'],
    })
    await select(page, 'none')
    await hoverAt(page, anchors.empty)
    expect(await keys(page, 'hovered')).toEqual([])
    expect(
        await page.evaluate(() =>
            window.editorTest.view.entities.creating.map(
                (entity) => `${entity.type}:${entity.beat}:${'left' in entity ? entity.left : ''}`,
            ),
        ),
    ).toEqual(['note:4:-5'])
    await page.mouse.click(anchors.empty.x, anchors.empty.y)
    expect(await changed(page, all, initial)).toEqual({
        added: ['note:4:-5'],
        removed: [],
        selected: ['note:4:-5'],
    })
    let added = 0
    const outcomes = new Set<string>()
    for (const point of await points(page)) {
        for (const which of ['none', 'inStack'] as const) {
            await select(page, which, 'eraser')
            await hoverAt(page, point)
            const hovered = await keys(page, 'hovered')
            await page.mouse.click(point.x, point.y)
            const result = await changed(page, all, initial)
            expect(result.removed, `eraser ${which} at ${point.x},${point.y}`).toEqual(hovered)
            expect(result.added).toEqual([])
            outcomes.add(hovered.length ? `erase ${which}` : 'erase miss')
        }
        await select(page, 'none', 'note')
        await hoverAt(page, point)
        const shown = await page.evaluate(() => {
            const { view } = window.editorTest
            const key = (entity: (typeof view.entities.hovered)[number]) =>
                `${entity.type}:${entity.beat}:${'left' in entity ? entity.left : ''}`
            return {
                hovered: view.entities.hovered.map(key).sort(),
                ghost: view.entities.creating.map(key).sort(),
            }
        })
        await page.mouse.click(point.x, point.y)
        const result = await changed(page, all, initial)
        if (shown.hovered.length) {
            outcomes.add('note select')
            expect(result, `note at ${point.x},${point.y}`).toEqual({
                added: [],
                removed: [],
                selected: shown.hovered,
            })
        } else {
            expect(result.added, `note add at ${point.x},${point.y}`).toEqual(shown.ghost)
            expect(result.removed).toEqual([])
            if (shown.ghost.length) added++
        }
    }
    expect(added).toBeGreaterThan(0)
    expect([...outcomes].sort()).toEqual([
        'erase inStack',
        'erase miss',
        'erase none',
        'note select',
    ])
})

test('Elevation Editor: the hover is what a tap selects, cycling', async ({ page }) => {
    test.slow()
    await page.evaluate(async () => {
        const { show, fixtures, settings, appImport } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                slides: [
                    [{ ...base, beat: 3, left: -2, size: 3, elevation: 2 }],
                    [{ ...base, beat: 3, left: -1, size: 3, elevation: 2.1 }],
                    [{ ...base, beat: 3, left: 0, size: 2, elevation: 2.2 }],
                    [{ ...base, beat: 3, left: 2.3, size: 1, elevation: 2.05 }],
                ],
            },
            3,
        )
        settings.showSidebar = false
        settings.showPreview = false
        settings.elevationEditorSideBySide = 'disallow'
        const { openElevationEditor } = await appImport<
            typeof import('../../src/editor/elevation/state')
        >('/src/editor/elevation/state.ts')
        openElevationEditor(3)
        const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
            '/src/editor/tools/index.ts',
        )
        switchToolTo('select')
    })
    await expect(page.locator('.elevation-canvas')).toBeVisible()
    const initial = await baseline(page)
    const { grid, anchors } = await page.evaluate(async () => {
        const { appImport, nextTick } = window.editorTest
        await nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
        const { elevationLayout } = await appImport<
            typeof import('../../src/editor/elevation/scene')
        >('/src/editor/elevation/scene.ts')
        const { elevationBounds } = await appImport<
            typeof import('../../src/editor/elevation/viewport')
        >('/src/editor/elevation/viewport.ts')
        const layout = elevationLayout.value
        const middle = layout.rows.find((row) => row.note.elevation === 2.1)!
        const isolated = layout.rows.find((row) => row.note.left === 2.3)!
        const result: { name: string; x: number; y: number; expected?: string[] }[] = []
        const add = (name: string, lane: number, y: number, dx = 0, dy = 0, expected?: string[]) =>
            result.push({
                name,
                x: Math.round(elevationBounds.x + layout.xAt(lane) + dx),
                y: Math.round(elevationBounds.y + y + dy),
                expected,
            })
        for (let lane = -2.5; lane <= 3.5; lane += 0.35) add(`horizontal ${lane}`, lane, middle.y)
        for (const dy of [-30, -15, -5, 0, 5, 15, 30])
            add(`vertical overlap ${dy}`, 1.7, middle.y, 0, dy)
        const scale = layout.laneScale
        for (const row of [layout.rows.find((row) => row.note.left === -2)!, isolated]) {
            const lane = row.note.left + row.note.size / 2
            const half = Math.max(row.w, 1.5 * scale) / 2
            for (const side of [-1, 1])
                for (const delta of [-1, 1]) {
                    add(
                        `${row.note.left} direct span ${side} ${delta}`,
                        lane,
                        row.y,
                        side * half + delta,
                    )
                    add(
                        `${row.note.left} side reach ${side} ${delta}`,
                        lane,
                        row.y,
                        side * (half + 10) + delta,
                        0,
                        row === isolated && side === 1
                            ? delta < 0
                                ? ['note:3:2.3']
                                : []
                            : row !== isolated && side === -1
                              ? delta > 0
                                  ? ['note:3:-2']
                                  : []
                              : undefined,
                    )
                    add(
                        `${row.note.left} vertical reach ${side} ${delta}`,
                        lane,
                        row.y,
                        0,
                        side * Math.max(14, scale * 0.3 + 10) + delta,
                        row === isolated
                            ? side * delta < 0
                                ? ['note:3:2.3']
                                : []
                            : side === 1
                              ? delta < 0
                                  ? ['note:3:-2']
                                  : []
                              : undefined,
                    )
                }
        }
        add('diagonal inside', -2, middle.y, -9, 21, ['note:3:-2'])
        add('diagonal outside', -2, middle.y, -11, 23, [])
        return {
            grid: result,
            anchors: {
                isolated: {
                    x: elevationBounds.x + isolated.x,
                    y: elevationBounds.y + isolated.y,
                },
                overlap: {
                    x: elevationBounds.x + layout.xAt(0.5),
                    y: elevationBounds.y + middle.y,
                },
                empty: {
                    x: elevationBounds.x + layout.xAt(-5),
                    y: elevationBounds.y + middle.y,
                },
            },
        }
    })
    await select(page, 'none')
    await tapExpected(page, anchors.isolated, ['note:3:2.3'], initial)
    await select(page, 'none')
    for (const expected of ['note:3:0', 'note:3:-1', 'note:3:-2', 'note:3:0'])
        await tapExpected(page, anchors.overlap, [expected], initial)
    await select(page, 'outside')
    await tapExpected(page, anchors.empty, [], initial)
    const seen = new Set<string>()
    let check: ((selected: string[]) => void) | undefined
    for (const point of grid) {
        for (const which of ['none', 'inStack', 'outside'] as const) {
            check?.(await select(page, which, undefined, initial))
            await hoverAt(page, point)
            const hovered = await keys(page, 'hovered', initial)
            if (point.expected) expect(hovered, point.name).toEqual(point.expected)
            await page.mouse.click(point.x, point.y)
            check = (selected) =>
                expect(selected, `${which} ${point.name} at ${point.x},${point.y}`).toEqual(hovered)
            recordHits(seen, hovered)
        }
    }
    check?.(await keys(page, 'selected', initial))
    expect([...seen].sort()).toEqual(
        ['note:3:0', 'note:3:-1', 'note:3:-2', 'note:3:2.3', 'hit', 'miss'].sort(),
    )
})

test("Select: with a joint selected, the hover on a chain-mate's marker over a note is what a tap selects", async ({
    page,
}) => {
    await page.evaluate(async () => {
        const { show, fixtures, appImport } = window.editorTest
        const events = fixtures.events
        const pivot = { ...events.stagePivotEvents[0]!, pivotLane: 0 }
        show(
            {
                ...events,
                bpms: [{ beat: 0, bpm: 120 }],
                cameraEvents: [],
                stageMaskEvents: [],
                stagePivotEvents: [
                    { ...pivot, beat: 4 },
                    { ...pivot, beat: 8 },
                ],
                stageStyleEvents: [],
                stageTransformEvents: [],
                timeScales: [],
                slides: [[{ ...fixtures.interaction.slides[0]![0]!, beat: 4, left: -1, size: 2 }]],
            },
            2,
        )
        const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
            '/src/editor/tools/index.ts',
        )
        switchToolTo('select')
    })
    const spot = await page.evaluate(() => window.editorTest.point(0, 4))
    // The joint at beat 8 raises the one at 4 over the note; with the note selected too, it is on top.
    for (const [selection, expected] of [
        [['pivot:8'], ['stagePivotEventJoint:4:']],
        [['pivot:8', 'note'], ['note:4:-1']],
    ] as const) {
        await page.evaluate((selection) => {
            const { history, store } = window.editorTest
            history.replaceState({
                ...history.state.value,
                selectedEntities: selection.map((name) =>
                    [...store.getAllEntities()].find(
                        (entity) =>
                            (entity.type === 'stagePivotEventJoint'
                                ? `pivot:${entity.beat}`
                                : entity.type) === name,
                    )!,
                ),
            })
        }, selection)
        await hoverAt(page, spot)
        expect(await keys(page, 'hovered')).toEqual(expected)
        await page.mouse.click(spot.x, spot.y)
        expect(await keys(page, 'selected')).toEqual(expected)
    }
})
