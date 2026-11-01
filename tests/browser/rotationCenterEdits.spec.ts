import { expect, test, type Page } from '@playwright/test'
import type { StageTransformEventObject } from '../../src/chart/events/stage/transform'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

/** Shows the event fixture with its first transform event centered on the screen, selected. */
const showCentered = (page: Page) =>
    page.evaluate(() => {
        const { fixtures, show, history, store } = window.editorTest
        const [first, ...rest] = fixtures.events.stageTransformEvents
        show({
            ...fixtures.events,
            stageTransformEvents: [
                {
                    ...first!,
                    rotation: 30,
                    xTranslation: 2,
                    rotationCenter: 'screen',
                    centerXOffset: 1.5,
                    centerYOffset: -0.5,
                },
                ...rest,
            ],
        })
        const entity = [...store.getAllEntities()].find(
            (entity) => entity.type === 'stageTransformEventJoint' && entity.beat === first!.beat,
        )!
        history.replaceState({ ...history.state.value, selectedEntities: [entity] })
    })

type Center = Pick<
    StageTransformEventObject,
    'rotation' | 'rotationCenter' | 'centerXOffset' | 'centerYOffset'
>

const center = (rotation: number, rotationCenter: string, x: number, y: number) => ({
    rotation,
    rotationCenter,
    centerXOffset: x,
    centerYOffset: y,
})

test('Flip negates the center X offset beside the rotation and the X translation', async ({
    page,
}) => {
    await showCentered(page)
    const flipped = await page.evaluate(async () => {
        const { history, appImport } = window.editorTest
        const { commands } = await appImport<typeof import('../../src/editor/commands')>(
            '/src/editor/commands/index.ts',
        )
        await commands.flip.execute()
        const { xTranslation, rotation, rotationCenter, centerXOffset, centerYOffset } = history
            .state.value.selectedEntities[0] as StageTransformEventObject
        return { xTranslation, rotation, rotationCenter, centerXOffset, centerYOffset }
    })
    expect(flipped).toEqual({ xTranslation: -2, ...center(-30, 'screen', -1.5, -0.5) })
})

test('Flip counts a transform event whose only mirrored value is its center X offset', async ({
    page,
}) => {
    const operation = await page.evaluate(async () => {
        const { fixtures, show, history, store, appImport } = window.editorTest
        const [first, second, ...rest] = fixtures.events.stageTransformEvents
        show({
            ...fixtures.events,
            stageTransformEvents: [
                { ...first!, rotation: 30 },
                { ...second!, rotation: 0, xTranslation: 0, centerXOffset: 1 },
                ...rest,
            ],
        })
        const beats = [first!.beat, second!.beat]
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...store.getAllEntities()].filter(
                (entity) =>
                    entity.type === 'stageTransformEventJoint' && beats.includes(entity.beat),
            ),
        })
        const { commands } = await appImport<typeof import('../../src/editor/commands')>(
            '/src/editor/commands/index.ts',
        )
        await commands.flip.execute()
        return history.headStep.value?.operation
    })
    expect(operation).toMatchObject({
        id: 'nse.object.flip',
        data: { axis: 'horizontal', changed: { stageTransformEvent: 2 } },
    })
})

test('a flipped paste negates the center X offset as Flip does', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await showCentered(page)
    const pasted = await page.evaluate(async () => {
        const { history, appImport } = window.editorTest
        const { commands } = await appImport<typeof import('../../src/editor/commands')>(
            '/src/editor/commands/index.ts',
        )
        const { pasteAtPosition } = await appImport<typeof import('../../src/editor/tools/paste')>(
            '/src/editor/tools/paste/index.ts',
        )
        await commands.copy.execute()
        const centers: Center[] = []
        for (const shift of [false, true]) {
            await pasteAtPosition(0, 8, { ctrl: false, shift })
            const entity = history.state.value.selectedEntities[0] as StageTransformEventObject
            const { rotation, rotationCenter, centerXOffset, centerYOffset } = entity
            centers.push({ rotation, rotationCenter, centerXOffset, centerYOffset })
        }
        return centers
    })
    expect(pasted).toEqual([center(30, 'screen', 1.5, -0.5), center(-30, 'screen', -1.5, -0.5)])
})

test('a new transform event takes each center field from the tool, else the selected event, else Stage Center and 0', async ({
    page,
}) => {
    await showCentered(page)
    const created = await page.evaluate(async () => {
        const { history, view, point, appImport } = window.editorTest
        const { stageTransformEvent, defaultStageTransformEventProperties } = await appImport<
            typeof import('../../src/editor/tools/events/stage/transform')
        >('/src/editor/tools/events/stage/transform/index.ts')
        const modifiers = { ctrl: false, shift: false }
        // An empty spot: the fixture's transform events are at beats 4, 9 and 14.
        const { x, y } = point(0, 11)
        const centerOf = (entity: unknown): Center => {
            const { rotation, rotationCenter, centerXOffset, centerYOffset } =
                entity as StageTransformEventObject
            return { rotation, rotationCenter, centerXOffset, centerYOffset }
        }
        // The ghost an empty spot shows is the event a tap there adds.
        const ghost = async () => {
            await stageTransformEvent.hover?.(x, y, modifiers)
            return centerOf(view.entities.creating[0])
        }
        const selected = history.state.value.selectedEntities
        const results: Record<string, Center> = {}

        results.selected = await ghost()
        defaultStageTransformEventProperties.value = {
            copyProperties: true,
            rotationCenter: 'vanishingPoint',
            centerYOffset: 2,
        }
        results.tool = await ghost()
        defaultStageTransformEventProperties.value = { copyProperties: false }
        results.notCopied = await ghost()
        defaultStageTransformEventProperties.value = { copyProperties: true }
        history.replaceState({ ...history.state.value, selectedEntities: [] })
        results.none = await ghost()

        history.replaceState({ ...history.state.value, selectedEntities: selected })
        await stageTransformEvent.tap?.(x, y, modifiers)
        results.added = centerOf(history.state.value.selectedEntities[0])
        return results
    })
    expect(created).toEqual({
        selected: center(30, 'screen', 1.5, -0.5),
        tool: center(30, 'vanishingPoint', 1.5, 2),
        notCopied: center(0, 'stage', 0, 0),
        none: center(0, 'stage', 0, 0),
        added: center(30, 'screen', 1.5, -0.5),
    })
})
