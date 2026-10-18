import { expect, test } from '@playwright/test'
import { gunzipSync } from 'node:zlib'
import { installEditorFixture, waitForStartup } from './editorFixture'

type LevelData = { entities: { data: { name: string; value?: number }[] }[] }

const easeValues = (levelData: LevelData) =>
    levelData.entities.flatMap((entity) =>
        entity.data.flatMap(({ name, value }) =>
            ['connectorEase', 'ease', '#TIMESCALE_EASE'].includes(name) && value !== undefined
                ? [value]
                : [],
        ),
    )

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('sonolus-next-sekai-editor.showPreview', 'false')
    })
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await waitForStartup(page)
    await page.evaluate(installEditorFixture)
    await page.evaluate(() => {
        const { fixtures, show } = window.editorTest
        const base = fixtures.events.slides[0]![0]!
        // Camera events and time scales are None; mask events and the connector are In Step.
        show(
            {
                ...fixtures.events,
                cameraEvents: fixtures.events.cameraEvents.map((e) => ({
                    ...e,
                    eventEase: 'none',
                })),
                stageMaskEvents: fixtures.events.stageMaskEvents.map((e) => ({
                    ...e,
                    eventEase: 'inStep',
                })),
                timeScales: fixtures.events.timeScales.map((e) => ({
                    ...e,
                    timeScaleEase: 'none',
                })),
                slides: [
                    [
                        { ...base, beat: 4, connectorEase: 'inStep' },
                        { ...base, beat: 6, connectorEase: 'inStep' },
                    ],
                ],
            },
            2,
        )
    })
})

test('copy writes None as NONE and In Step as IN_STEP, and pastes each back', async ({
    page,
    context,
}) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.evaluate(() => {
        const { history, store } = window.editorTest
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...store.getAllEntities()].filter(
                (entity) =>
                    entity.type === 'note' ||
                    entity.type === 'cameraEventJoint' ||
                    entity.type === 'stageMaskEventJoint' ||
                    entity.type === 'timeScale',
            ),
        })
    })
    const source = await page.evaluate(() => window.editorTest.point(0, 4))
    await page.mouse.move(source.x, source.y)
    await page.keyboard.press('c')
    await expect
        .poll(async () =>
            easeValues(
                await page.evaluate(
                    async () =>
                        JSON.parse(await navigator.clipboard.readText()) as {
                            entities: LevelData['entities']
                        },
                ),
            ),
        )
        .toEqual(expect.arrayContaining([0, 38]))
    const copied = easeValues(
        await page.evaluate(
            async () =>
                JSON.parse(await navigator.clipboard.readText()) as {
                    entities: LevelData['entities']
                },
        ),
    )
    expect(copied.filter((value) => value !== 0 && value !== 38)).toEqual([])

    await page.keyboard.press('v')
    const target = await page.evaluate(() => window.editorTest.point(0, 30))
    await page.mouse.click(target.x, target.y)
    await expect
        .poll(() =>
            page.evaluate(() => {
                const pasted = window.editorTest.history.state.value.selectedEntities
                const eases = (type: string) => [
                    ...new Set(
                        pasted.flatMap((entity) =>
                            entity.type !== type
                                ? []
                                : entity.type === 'note'
                                  ? [entity.connectorEase]
                                  : entity.type === 'timeScale'
                                    ? [entity.timeScaleEase]
                                    : 'eventEase' in entity
                                      ? [entity.eventEase]
                                      : [],
                        ),
                    ),
                ]
                return {
                    note: eases('note'),
                    camera: eases('cameraEventJoint'),
                    mask: eases('stageMaskEventJoint'),
                    timeScale: eases('timeScale'),
                }
            }),
        )
        .toEqual({ note: ['inStep'], camera: ['none'], mask: ['inStep'], timeScale: ['none'] })
})

test('the journal writes None as NONE and In Step as IN_STEP', async ({ page }) => {
    // The journal written on hide, read at once: a strict commit clears it soon after.
    const levelDataGz = await page.evaluate(async () => {
        const { history, store } = window.editorTest
        const { editSelectedEditableEntities } =
            await import('/src/editor/sidebars/default/index.ts')
        const { session } = await import('/src/history/session.ts')
        const note = [...store.getAllEntities()].find((entity) => entity.type === 'note')!
        history.replaceState({ ...history.state.value, selectedEntities: [note] })
        editSelectedEditableEntities({ size: 3 })
        // Hiding the page journals the edit at once (Part 1 §1.6.4 #7).
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
        const text = localStorage.getItem(
            `sonolus-next-sekai-editor.journal.${session.value.sessionId}`,
        )
        return text ? (JSON.parse(text) as { levelDataGz: string }).levelDataGz : undefined
    })
    expect(levelDataGz).toBeDefined()
    const saved = () =>
        JSON.parse(gunzipSync(Buffer.from(levelDataGz!, 'base64')).toString()) as LevelData
    const values = easeValues((await saved())!)
    expect(values).toEqual(expect.arrayContaining([0, 38]))
})
