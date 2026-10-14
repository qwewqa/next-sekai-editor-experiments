import { expect, test } from '@playwright/test'
import type { Chart } from '../../src/chart'
import type { Entity } from '../../src/state/entities'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// The hit model is the ground truth for picking and drawing follows its drawn shapes:
// this flags where an object's drawn pixels and its drawn hit shape drift apart.

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

test('each object is drawn where its drawn hit shape is, and nowhere else', async ({ page }) => {
    const drift = await page.evaluate(async () => {
        const { show, fixtures, view, settings, history, appImport } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        const events = fixtures.events
        const timeScale = { ...events.timeScales[0]!, groupId: base.groupId, hideNotes: false }
        const chart: Chart = {
            ...events,
            isDynamicStages: true,
            bpms: [{ beat: 0, bpm: 120 }],
            slides: [
                [
                    { ...base, beat: 2, left: -6, size: 3 },
                    { ...base, beat: 3, left: -6, size: 3, isAttached: true },
                    { ...base, beat: 4, left: -6, size: 3 },
                ],
                [{ ...base, beat: 2, left: 0, size: 2 }],
                [{ ...base, beat: 3, left: 0, size: 2, noteType: 'trace' }],
                [{ ...base, beat: 4, left: 0, size: 2, noteType: 'damage' }],
                [{ ...base, beat: 5, left: 0, size: 2, noteType: 'anchor' }],
                [{ ...base, beat: 6, left: 0, size: 2, noteType: 'forceTick' }],
                [{ ...base, beat: 2, left: 4, size: 0 }],
                [{ ...base, beat: 3, left: 4, size: 0, noteType: 'anchor' }],
                [{ ...base, beat: 4, left: 4, size: 0, noteType: 'trace' }],
                [{ ...base, beat: 5, left: 4, size: 0, noteType: 'forceTick' }],
            ],
            cameraEvents: [{ ...events.cameraEvents[0]!, beat: 7, cameraLeft: -6, cameraSize: 4 }],
            stageMaskEvents: [
                { ...events.stageMaskEvents[0]!, beat: 7.5, maskLeft: 0, maskSize: 3 },
            ],
            stagePivotEvents: [{ ...events.stagePivotEvents[0]!, beat: 8, pivotLane: -4 }],
            stageStyleEvents: [{ ...events.stageStyleEvents[0]!, beat: 8, editorLane: -1 }],
            stageTransformEvents: [
                { ...events.stageTransformEvents[0]!, beat: 8, xTranslation: 2 },
            ],
            timeScales: [
                { ...timeScale, beat: 7, editorLane: 4, timeScaleTransition: 'timeScale' },
                { ...timeScale, beat: 8, editorLane: 4.5, timeScaleTransition: 'scroll' },
            ],
        }
        show(chart, 2.5)
        settings.width = view.w / 40
        settings.pps = 100
        settings.showStageName = false
        settings.showGroupName = false
        view.lane = 0

        const imp = <T>(path: string) => appImport<T>(path)
        const notesMod = await imp<typeof import('../../src/editor/canvas/notes')>(
            '/src/editor/canvas/notes.ts',
        )
        const eventsMod = await imp<typeof import('../../src/editor/canvas/events')>(
            '/src/editor/canvas/events.ts',
        )
        const surface = await imp<typeof import('../../src/editor/canvas/surface')>(
            '/src/editor/canvas/surface.ts',
        )
        const labelSprites = await imp<typeof import('../../src/editor/canvas/labelSprites')>(
            '/src/editor/canvas/labelSprites.ts',
        )
        const names = await imp<typeof import('../../src/editor/canvas/names')>(
            '/src/editor/canvas/names.ts',
        )
        const viewMod = await imp<typeof import('../../src/editor/view')>('/src/editor/view.ts')
        const model =
            await imp<typeof import('../../src/editor/hitModel')>('/src/editor/hitModel.ts')
        const { beatToTime } = await imp<typeof import('../../src/state/integrals/bpms')>(
            '/src/state/integrals/bpms.ts',
        )
        const state = history.state.value
        const bounds = viewMod.viewBox.value
        const scale = view.w / bounds.w
        const canvas = document.createElement('canvas')
        const ctx = surface.prepareSurface(canvas, view.w, view.h, 1, bounds)!
        const renderer = notesMod.createNoteRenderer()
        const sprites = labelSprites.createLabelSprites()
        renderer.beginFrame(1)
        sprites.beginFrame(1)
        const context = {
            ctx,
            width: view.w,
            height: view.h,
            scale,
            pixelRatio: 1,
            bounds,
            ups: bounds.ups,
            state,
            composed: undefined,
            defaultGroupId: base.groupId,
            showStageName: false,
            showGroupName: false,
            nameContrast: false,
            chartBackground: '#000',
            // Anchors and ticks show their outlines, as whenever the view is active.
            recentlyActive: true,
            fontFamily: 'sans-serif',
            fontMiddle: 0.25,
            figureMiddle: 0.35,
            redrawVersion: 0,
            nameSprites: sprites,
            names: names.createNameLayer(),
        }
        // Three pixels either way.
        const tolerance = 3 / scale
        const eventTypes = [
            'cameraEventJoint',
            'stageMaskEventJoint',
            'stagePivotEventJoint',
            'stageStyleEventJoint',
            'stageTransformEventJoint',
            'timeScale',
        ] as const
        const entities: Entity[] = [
            ...[...state.store.slides.note.values()].flat(),
            ...eventTypes.flatMap((type) =>
                [...(state.store.grid[type] as Map<number, Set<Entity>>).values()].flatMap(
                    (set) => [...set],
                ),
            ),
        ]
        return entities.flatMap((entity) => {
            const shape = model.drawnShapeOf(entity, state, undefined)!
            const units = beatToTime(state.bpms, entity.beat) * bounds.ups
            ctx.save()
            ctx.setTransform(1, 0, 0, 1, 0, 0)
            ctx.clearRect(0, 0, canvas.width, canvas.height)
            ctx.restore()
            if (entity.type === 'note') renderer.draw(context as never, entity, false, 1)
            else eventsMod.drawEvent(context as never, entity as never, false, 1, 'marker')
            const outline =
                entity.type === 'note' &&
                (entity.noteType === 'anchor' ||
                    entity.noteType === 'forceTick' ||
                    entity.isAttached)
            const box = {
                l: Math.min(...shape.boxes.map(({ l }) => l)) - 0.5,
                r: Math.max(...shape.boxes.map(({ r }) => r)) + 0.5,
                t: -0.8,
                b: 0.8,
            }
            const px = (lane: number) => Math.round((lane - bounds.l) * scale)
            const py = (y: number) => Math.round((units + y - bounds.t) * scale)
            const x0 = px(box.l)
            const y0 = py(box.t)
            const w = px(box.r) - x0
            const h = py(box.b) - y0
            const data = ctx.getImageData(x0, y0, w, h).data
            const painted = (x: number, y: number) => data[(y * w + x) * 4 + 3]! >= 200
            let notHittable = 0
            let notDrawn = 0
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const lane = bounds.l + (x0 + x + 0.5) / scale
                    const across = bounds.t + (y0 + y + 0.5) / scale - units
                    if (painted(x, y) && model.shapeDistance(shape, lane, across) > tolerance)
                        notHittable++
                    // Filled boxes are drawn through; outlines only round their edges.
                    const inside = shape.boxes.some(
                        (b) =>
                            lane >= b.l + tolerance &&
                            lane <= b.r - tolerance &&
                            across >= b.t + tolerance &&
                            across <= b.b - tolerance,
                    )
                    if (inside && !outline && !painted(x, y)) notDrawn++
                }
            }
            // Outlines: each edge's middle.
            if (outline)
                for (const b of shape.boxes) {
                    const middle = (b.l + b.r) / 2
                    for (const [lane, across] of [
                        [b.l, 0],
                        [b.r, 0],
                        [middle, b.t],
                        [middle, b.b],
                    ] as const) {
                        const x = px(lane) - x0
                        const y = py(across) - y0
                        if (![-1, 0, 1].some((d) => painted(x + d, y) || painted(x, y + d)))
                            notDrawn++
                    }
                }
            return notHittable || notDrawn
                ? [
                      {
                          entity: `${entity.type}:${entity.beat}:${'noteType' in entity ? entity.noteType : ''}:${'size' in entity ? entity.size : ''}`,
                          notHittable,
                          notDrawn,
                      },
                  ]
                : []
        })
    })
    expect(drift).toEqual([])
})
