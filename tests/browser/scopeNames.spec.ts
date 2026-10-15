import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

declare global {
    interface Window {
        scopeNameDraws: Record<'chart' | 'elevation', string[]>
    }
}

const groupOption = 'Hide group names when focusing a group'
const stageOption = 'Hide stage names when focusing a stage'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

test('scope-name settings default on, persist independently and keep their place in Settings', async ({
    page,
}) => {
    await page.keyboard.press(',')
    const group = page.getByRole('switch', { name: groupOption, exact: true })
    const stage = page.getByRole('switch', { name: stageOption, exact: true })
    await expect(group).toHaveAttribute('aria-checked', 'true')
    await expect(stage).toHaveAttribute('aria-checked', 'true')
    const labels = await page.getByRole('dialog').locator('.form-field-text').allTextContents()
    expect(labels[labels.indexOf('Show Group Name') + 1]).toBe(groupOption)
    expect(labels[labels.indexOf('Show Stage Name') + 1]).toBe(stageOption)
    await group.click()
    expect(
        await page.evaluate(() =>
            localStorage.getItem('sonolus-next-sekai-editor.hideGroupNameWhenFocusingGroup'),
        ),
    ).toBe('false')
    await page.reload()
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.keyboard.press(',')
    await expect(group).toHaveAttribute('aria-checked', 'false')
    await expect(stage).toHaveAttribute('aria-checked', 'true')
    await group.click()
    await stage.click()
    await page.reload()
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    expect(
        await page.evaluate(() => ({
            group: window.editorTest.settings.hideGroupNameWhenFocusingGroup,
            stage: window.editorTest.settings.hideStageNameWhenFocusingStage,
            groupStored: localStorage.getItem(
                'sonolus-next-sekai-editor.hideGroupNameWhenFocusingGroup',
            ),
        })),
    ).toEqual({ group: true, stage: false, groupStored: null })
    await page.evaluate(async () => {
        const { resetSettings } =
            await window.editorTest.appImport<typeof import('../../src/settings')>(
                '/src/settings.ts',
            )
        resetSettings()
    })
    expect(
        await page.evaluate(() => [
            window.editorTest.settings.hideGroupNameWhenFocusingGroup,
            window.editorTest.settings.hideStageNameWhenFocusingStage,
        ]),
    ).toEqual([true, true])
})

const installNames = async (page: Page) =>
    page.evaluate(async () => {
        const { WebGLDrawContext } = await window.editorTest.appImport<
            typeof import('../../src/rendering/context')
        >('/src/rendering/context.ts')
        window.scopeNameDraws = { chart: [], elevation: [] }
        const pane = (canvas: HTMLCanvasElement | object) => {
            if (!(canvas instanceof HTMLCanvasElement)) return
            if (canvas.classList.contains('editor-chart')) return 'chart'
            if (canvas.classList.contains('elevation-canvas')) return 'elevation'
        }
        const record = (canvas: object, text: string | undefined) => {
            const key = pane(canvas)
            if (key && text && ['G0', 'G2', 'S0', 'S2'].includes(text))
                window.scopeNameDraws[key].push(text)
        }
        const proto = WebGLDrawContext.prototype
        const { clear, drawNameSprite, drawEditorLabel } = proto
        proto.clear = function () {
            const key = pane(this.canvas)
            if (key) window.scopeNameDraws[key] = []
            return clear.call(this)
        }
        proto.drawNameSprite = function (source, x, y) {
            record(this.canvas, window.editorLabels.get(source)?.text)
            return drawNameSprite.call(this, source, x, y)
        }
        proto.drawEditorLabel = function (text, ...args) {
            record(this.canvas, text)
            return drawEditorLabel.call(this, text, ...args)
        }
    })

type Visibility = {
    group?: number
    stage?: number
    hideGroup?: boolean
    hideStage?: boolean
    showGroup?: boolean
    showStage?: boolean
    highlight?: 'active' | 'selected' | 'hovered'
}

const configure = (page: Page, values: Visibility) =>
    page.evaluate(async (values) => {
        const { settings, view, history, nextTick } = window.editorTest
        settings.hideGroupNameWhenFocusingGroup = values.hideGroup ?? true
        settings.hideStageNameWhenFocusingStage = values.hideStage ?? true
        settings.showGroupName = values.showGroup ?? true
        settings.showStageName = values.showStage ?? true
        view.groupId = values.group as typeof view.groupId
        view.stageId = values.stage as typeof view.stageId
        const notes = [...history.state.value.store.slides.note.values()].flat()
        history.replaceState({
            ...history.state.value,
            selectedEntities: values.highlight === 'selected' ? notes : [],
        })
        view.entities = {
            ...view.entities,
            hovered: values.highlight === 'hovered' ? notes : [],
        }
        view.lastActive = !values.highlight || values.highlight === 'active' ? Infinity : -1000
        // Elevation follows the cursor's beat; keep its notes at the tested beat.
        view.cursorTime = 2
        await nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
    }, values)

for (const mode of ['basic', 'composed', 'elevation'] as const) {
    test(`${mode}: scope settings hide every corresponding name including selected and hovered notes`, async ({
        page,
    }) => {
        await installNames(page)
        await page.evaluate((mode) => {
            const { fixtures, show, settings, view } = window.editorTest
            const note = fixtures.interaction.slides[0]![0]!
            const stage = fixtures.events.stages.values().next().value!
            show(
                {
                    ...fixtures.interaction,
                    isDynamicStages: true,
                    groups: new Map([
                        [1 as typeof note.groupId, { name: 'Default' }],
                        [0 as typeof note.groupId, { name: 'G0' }],
                        [2 as typeof note.groupId, { name: 'G2' }],
                    ]),
                    stages: new Map([
                        [0 as typeof note.stageId, { ...stage, name: 'S0' }],
                        [2 as typeof note.stageId, { ...stage, name: 'S2' }],
                    ]),
                    slides: [
                        [
                            {
                                ...note,
                                beat: 4,
                                left: -4,
                                groupId: 0 as typeof note.groupId,
                                stageId: 0 as typeof note.stageId,
                            },
                        ],
                        [
                            {
                                ...note,
                                beat: 4,
                                left: 1,
                                groupId: 2 as typeof note.groupId,
                                stageId: 2 as typeof note.stageId,
                            },
                        ],
                    ],
                    timeScales: [
                        {
                            ...fixtures.events.timeScales[0]!,
                            beat: 3,
                            editorLane: -2,
                            groupId: 0 as typeof note.groupId,
                        },
                        {
                            ...fixtures.events.timeScales[0]!,
                            beat: 5,
                            editorLane: 2,
                            groupId: 2 as typeof note.groupId,
                        },
                    ],
                    stagePivotEvents: [
                        {
                            ...fixtures.events.stagePivotEvents[0]!,
                            beat: 3,
                            stageId: 0 as typeof note.stageId,
                        },
                        {
                            ...fixtures.events.stagePivotEvents[0]!,
                            beat: 5,
                            stageId: 2 as typeof note.stageId,
                        },
                    ],
                },
                2,
            )
            settings.showOtherGroups = true
            settings.showOtherStages = true
            settings.elevationEditorSideBySide = 'disallow'
            view.layout = mode === 'composed' ? 'composed' : 'basic'
            view.lastActive = Infinity
        }, mode)
        const pane: 'chart' | 'elevation' = mode === 'elevation' ? 'elevation' : 'chart'
        if (mode === 'elevation') {
            await page.keyboard.press('t')
            await expect(page.locator('canvas.elevation-canvas')).toBeVisible()
            const beat = page.getByRole('spinbutton', { name: 'Beat', exact: true })
            await beat.fill('5')
            await beat.press('Tab')
        }
        const names = () =>
            page.evaluate(
                (pane: 'chart' | 'elevation') => [...new Set(window.scopeNameDraws[pane])].sort(),
                pane,
            )
        const hoverElevationNote = async () => {
            const point = await page.evaluate(async () => {
                const { elevationLayout } = await window.editorTest.appImport<
                    typeof import('../../src/editor/elevation/scene')
                >('/src/editor/elevation/scene.ts')
                const row = elevationLayout.value.rows[0]!
                const rect = document
                    .querySelector('canvas.elevation-canvas')!
                    .getBoundingClientRect()
                return { x: rect.left + row.x, y: rect.top + row.y }
            })
            await page.mouse.move(point.x, point.y)
            await page.evaluate(async () => {
                window.editorTest.view.lastActive = -1000
                await window.editorTest.nextTick()
                await new Promise<void>((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                )
            })
        }
        await configure(page, {})
        await expect.poll(names).toEqual(['G0', 'G2', 'S0', 'S2'])
        await configure(page, { group: 0 })
        // Elevation intentionally omits notes outside the editable scope;
        // the main chart retains them faintly with Show Other enabled.
        await expect.poll(names).toEqual(mode === 'elevation' ? ['S0'] : ['S0', 'S2'])
        await configure(page, { stage: 0 })
        await expect.poll(names).toEqual(mode === 'elevation' ? ['G0'] : ['G0', 'G2'])
        for (const highlight of ['active', 'selected', 'hovered'] as const) {
            await configure(page, { group: 0, stage: 0, highlight })
            if (mode === 'elevation' && highlight === 'hovered') await hoverElevationNote()
            await expect.poll(names, highlight).toEqual([])
        }
        await configure(page, {
            group: 0,
            stage: 0,
            hideGroup: false,
            hideStage: false,
            highlight: 'hovered',
        })
        if (mode === 'elevation') await hoverElevationNote()
        await expect
            .poll(names)
            .toEqual(mode === 'elevation' ? ['G0', 'S0'] : ['G0', 'G2', 'S0', 'S2'])
        await configure(page, { group: 0, stage: 0, hideGroup: false })
        await expect.poll(names).toEqual(mode === 'elevation' ? ['G0'] : ['G0', 'G2'])
        await configure(page, { group: 0, stage: 0, hideStage: false })
        await expect.poll(names).toEqual(mode === 'elevation' ? ['S0'] : ['S0', 'S2'])
        await configure(page, {
            hideGroup: false,
            hideStage: false,
            showGroup: false,
            showStage: false,
        })
        await expect.poll(names).toEqual([])
        await configure(page, {})
        await expect.poll(names).toEqual(['G0', 'G2', 'S0', 'S2'])
    })
}
