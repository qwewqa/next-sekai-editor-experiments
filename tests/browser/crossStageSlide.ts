import type { Page } from '@playwright/test'

export type Layout = 'basic' | 'composed'

// Stage 1: pivot 0 to 4, X translation 0 to 4 and elevation 0 to 2 over beats 0 to 8.
// Stage 2: pivot 4.5, X translation -3, elevation 1. Slide S runs from stage 1 (beat 2,
// elevation 1) to stage 2 (beat 6, size 3, elevation 3), with a tick on stage 1 at beat 4
// drawn at left -1.25, size 2.5 and effective elevation 3: stored on stage 1, left -5.25
// and elevation 2. The tail is in group 2. Note N on stage 2 sits apart at beat 8.
// Ticks adds more attached ticks to S on stage 1 at those beats.
export const setup = (page: Page, layout: Layout, sameBeat = false, ticks: number[] = []) =>
    page.evaluate(
        async ({ layout, sameBeat, ticks }) => {
            const { fixtures, show, view, settings, appImport } = window.editorTest
            const { addToStages } =
                await appImport<typeof import('../../src/chart/stages')>('/src/chart/stages.ts')
            const { addToGroups } =
                await appImport<typeof import('../../src/chart/groups')>('/src/chart/groups.ts')
            // The fixture's ids were not minted; move both counters past them.
            while (addToStages(new Map())[0] < 2);
            while (addToGroups(new Map())[0] < 2);
            const chart = fixtures.interaction
            const base = chart.slides[0]![0]!
            const [stageA, stageB] = [...fixtures.events.stages.keys()]
            const pivot = fixtures.events.stagePivotEvents[0]!
            const transform = fixtures.events.stageTransformEvents[0]!
            const slide = sameBeat
                ? [
                      { ...base, stageId: stageA!, beat: 4, left: -4, size: 2, elevation: 0 },
                      {
                          ...base,
                          stageId: stageA!,
                          beat: 4,
                          left: 0,
                          size: 2,
                          elevation: 1,
                          isAttached: true,
                      },
                      {
                          ...base,
                          stageId: stageB!,
                          groupId: 2 as never,
                          beat: 4,
                          left: -4,
                          size: 3,
                          elevation: 4,
                      },
                  ]
                : [
                      { ...base, stageId: stageA!, beat: 2, left: -4, size: 2, elevation: 1 },
                      {
                          ...base,
                          stageId: stageA!,
                          beat: 4,
                          left: 0,
                          size: 2,
                          elevation: 0,
                          isAttached: true,
                      },
                      {
                          ...base,
                          stageId: stageB!,
                          groupId: 2 as never,
                          beat: 6,
                          left: -4,
                          size: 3,
                          elevation: 3,
                      },
                  ]
            show(
                {
                    ...fixtures.events,
                    bpms: chart.bpms,
                    cameraEvents: [],
                    stageMaskEvents: [],
                    stageStyleEvents: [],
                    timeScales: [],
                    stagePivotEvents: [
                        { ...pivot, stageId: stageA!, beat: 0, pivotLane: 0, eventEase: 'linear' },
                        { ...pivot, stageId: stageA!, beat: 8, pivotLane: 4, eventEase: 'linear' },
                        {
                            ...pivot,
                            stageId: stageB!,
                            beat: 0,
                            pivotLane: 4.5,
                            divisionParity: 'odd',
                            eventEase: 'linear',
                        },
                    ],
                    stageTransformEvents: [
                        {
                            ...transform,
                            stageId: stageA!,
                            beat: 0,
                            xTranslation: 0,
                            elevation: 0,
                            eventEase: 'linear',
                        },
                        {
                            ...transform,
                            stageId: stageA!,
                            beat: 8,
                            xTranslation: 4,
                            elevation: 2,
                            eventEase: 'linear',
                        },
                        {
                            ...transform,
                            stageId: stageB!,
                            beat: 0,
                            xTranslation: -3,
                            elevation: 1,
                            eventEase: 'linear',
                        },
                    ],
                    slides: [
                        [
                            ...slide,
                            ...ticks.map((beat) => ({
                                ...base,
                                stageId: stageA!,
                                beat,
                                left: 0,
                                size: 2,
                                elevation: 0,
                                isAttached: true,
                            })),
                        ],
                        [
                            {
                                ...base,
                                stageId: stageB!,
                                groupId: 2 as never,
                                beat: 8,
                                left: 0,
                                size: 2,
                            },
                        ],
                    ],
                },
                2,
            )
            view.layout = layout
            settings.mouseSecondaryTool = 'selectContextMenu'
            Object.defineProperty(navigator.clipboard, 'writeText', {
                configurable: true,
                value: async () => undefined,
            })
            Object.defineProperty(navigator.clipboard, 'readText', {
                configurable: true,
                value: async () => {
                    throw new DOMException('Clipboard denied', 'NotAllowedError')
                },
            })
        },
        { layout, sameBeat, ticks },
    )

export type Brief = {
    beat: number
    left: number
    size: number
    elevation: number
    attached: boolean
    stage: number
    drawn: { left: number; size: number }
}

/** Every note with its Composed (gameplay) lane, sorted by stage then beat. */
export const notes = (page: Page) =>
    page.evaluate(async () => {
        const { appImport, history } = window.editorTest
        const { createComposedLayout } =
            await appImport<typeof import('../../src/editor/composed')>('/src/editor/composed.ts')
        const source = history.state.value
        const layout = createComposedLayout(source)
        return [...source.store.slides.note.values()]
            .flat()
            .map((note) => ({
                beat: note.beat,
                left: note.left,
                size: note.size,
                elevation: note.elevation ?? 0,
                attached: note.isAttached,
                stage: note.stageId as number,
                drawn: layout.notePosition(note),
            }))
            .sort((a, b) => a.stage - b.stage || a.beat - b.beat)
    })

export const point = (page: Page, lane: number, beat: number) =>
    page.evaluate(([lane, beat]) => window.editorTest.point(lane!, beat!), [lane, beat])
