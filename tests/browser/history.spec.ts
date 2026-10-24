import { expect, test, type Page } from '@playwright/test'
import { gzipSync } from 'node:zlib'
import { parseAutoSave } from '../../src/history/autoSave/parse'
import { confirmWhenReady } from './confirmWhenReady'
import { closePage, installEditorFixture, waitForStartup } from './editorFixture'
import legacyColors from './fixtures/legacy-colors.json' with { type: 'json' }

// History across loads (Part 1 §1.3.8, §1.8, Step 4's spec migration): today's auto save is
// retired. The old slot migrates into a session, a closed tab's work comes back through its
// journal and the new visit that continues its session, and a reload keeps the session.

const prefix = 'sonolus-next-sekai-editor.'

/** Waits until the page's startup has opened its session (the startup gate's state). */
const opened = waitForStartup

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        performance.setResourceTimingBufferSize(5000)
        const prefix = 'sonolus-next-sekai-editor.'
        localStorage.setItem(`${prefix}showPreview`, 'false')
        localStorage.setItem(`${prefix}showSidebar`, 'false')
        // The storage test hooks (`nseFlushTest`), in every tab of the context.
        localStorage.setItem('nse.test.storage', '{}')
    })
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    // Storing has started: what the tests make is stored or journalled from here on.
    await opened(page)
    await page.evaluate(installEditorFixture)
})

/** The open chart as level data, and the session's source name. */
const openLevel = (page: Page) =>
    page.evaluate(async () => {
        const find = (pathname: string) =>
            performance
                .getEntriesByType('resource')
                .map((entry) => entry.name)
                .find((name) => new URL(name).pathname === pathname) ?? pathname
        const { state } = (await import(
            find('/src/history/index.ts')
        )) as typeof import('../../src/history')
        const { session } = (await import(
            find('/src/history/session.ts')
        )) as typeof import('../../src/history/session')
        const { serializeToLevelData } = (await import(
            find('/src/levelData/serialize.ts')
        )) as typeof import('../../src/levelData/serialize')
        const s = state.value
        return {
            filename: session.value.sourceName,
            data: serializeToLevelData(
                s.initialLife,
                s.isDynamicStages,
                s.bgm.offset,
                s.store,
                s.groups,
                s.stages,
            ),
        }
    })

/** How many entries of this tab's session the flusher still holds, not yet stored. */
const waiting = (page: Page) =>
    page.evaluate(async () => {
        const pathname = '/src/local/storing.ts'
        const url =
            performance
                .getEntriesByType('resource')
                .map((entry) => entry.name)
                .find((name) => new URL(name).pathname === pathname) ?? pathname
        const { flusher } = (await import(url)) as typeof import('../../src/local/storing')
        return flusher?.session?.pending.length ?? 0
    })

/** A new page in the context, as a new visit. */
const newVisit = async (page: Page) => {
    const next = await page.context().newPage()
    await next.goto('/')
    await expect(next.locator('canvas.editor-chart')).toBeVisible()
    await opened(next)
    return next
}

const canvasColors = (page: Page) =>
    page.evaluate(async () => {
        // Observe the initial restored rendering without forcing a view/state change.
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
        const canvas = document.querySelector<HTMLCanvasElement>('canvas.editor-chart')!
        // A restored page deliberately has no fixture: installing one would
        // replace the recovered chart whose initial pixels this probe checks.
        const pathname = '/src/rendering/context.ts'
        const moduleUrl = performance
            .getEntriesByType('resource')
            .reverse()
            .find((entry) => new URL(entry.name).pathname === pathname)?.name
        const rendering =
            window.editorRendering ??
            ((await import(moduleUrl ?? pathname)) as typeof import('../../src/rendering/context'))
        const pixels = rendering
            .getDrawContext(canvas)
            .getImageData(0, 0, canvas.width, canvas.height).data
        // Count saturated blue notes and purple connectors on the actual editor surface.
        let blue = 0
        let purple = 0
        for (let i = 0; i < pixels.length; i += 4) {
            const [r, g, b, a] = pixels.subarray(i, i + 4)
            if (a! < 100) continue
            if (Math.abs(r! - 153) <= 2 && Math.abs(g! - 170) <= 2 && b! >= 253) blue++
            if (Math.abs(r! - 214) <= 2 && Math.abs(g! - 115) <= 2 && Math.abs(b! - 205) <= 2)
                purple++
        }
        return { blue, purple }
    })

/** The journal of this tab's open session, as level data, or undefined. */
const journalLevel = (page: Page) =>
    page.evaluate(async () => {
        const { session } =
            (await import('/src/history/session.ts')) as typeof import('../../src/history/session')
        const text = localStorage.getItem(
            `sonolus-next-sekai-editor.journal.${session.value.sessionId}`,
        )
        if (!text) return
        const journal = JSON.parse(text) as { levelDataGz: string }
        const bytes = Uint8Array.from(atob(journal.levelDataGz), (c) => c.charCodeAt(0))
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
        return JSON.parse(await new Response(stream).text()) as {
            entities: { data: { name: string; value?: number }[] }[]
        }
    })

/** Holds flushes, as a kill leaves them: only the journal has the edits after this. */
const stallFlushes = async (page: Page) => {
    await expect.poll(() => page.evaluate(() => window.nseStartupTest !== undefined)).toBe(true)
    await page.evaluate(() => {
        window.nseFlushTest!.stall = true
    })
}

const hidePage = (page: Page) =>
    page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
    })

// Fixture generated with the unmodified serializers from de281ff, before the
// two color fields were unified. It includes every guide color, normal/fake
// active and damage connectors, camera motion, masks, elevation and time scales.
for (const format of ['compressed', 'unversioned'] as const) {
    test(`an old ${format} auto save migrates into the session a new visit continues, its chart and colors kept`, async ({
        page,
    }) => {
        const { levelData } = parseAutoSave(legacyColors.autoSave)
        // Upgrades write default meters (5aef4e8); legacy NONE stays NONE.
        const upgraded = structuredClone(levelData)
        for (const entity of upgraded.entities) {
            if (entity.archetype === '#BPM_CHANGE' && !entity.data.some((d) => d.name === 'meter'))
                entity.data.push({ name: 'meter', value: 4 })
        }
        // And the latest engine revision, after the initial life.
        upgraded.entities[0]!.data.splice(1, 0, { name: 'revision', value: 2 })
        const stored = JSON.stringify(format === 'compressed' ? legacyColors.autoSave : levelData)
        await page.evaluate(
            ({ stored, prefix }) => {
                localStorage.setItem(`${prefix}autoSave.levelData`, stored)
            },
            { stored, prefix },
        )
        const next = await newVisit(page)
        await expect.poll(async () => (await openLevel(next)).data).toEqual(upgraded)
        // No dialog at load: the startup pill says it (§1.4.3).
        await expect(next.getByRole('dialog')).toHaveCount(0)
        expect(
            await next.evaluate(async () => {
                const { state } =
                    (await import('/src/history/index.ts')) as typeof import('../../src/history')
                return [...state.value.store.slides.note.values()]
                    .slice(0, 8)
                    .map(([head]) => head!.connectorStyle)
            }),
        ).toEqual(['neutral', 'red', 'green', 'blue', 'yellow', 'purple', 'cyan', 'black'])
        // The old key went.
        expect(
            await next.evaluate(
                (prefix) => localStorage.getItem(`${prefix}autoSave.levelData`),
                prefix,
            ),
        ).toBeNull()
    })
}

test('an old auto save this build cannot read stays, never loaded, and the load says so', async ({
    page,
}) => {
    const future = JSON.stringify({
        version: 1,
        filename: 'future-chart',
        levelData: gzipSync(
            JSON.stringify({
                bgmOffset: 0,
                entities: [
                    { archetype: 'Initialization', data: [] },
                    { archetype: 'FutureNote', data: [] },
                ],
            }),
        ).toString('base64'),
    })
    await page.evaluate(
        ({ future, prefix }) => {
            localStorage.setItem(`${prefix}autoSave.levelData`, future)
        },
        { future, prefix },
    )
    const next = await newVisit(page)
    await expect(next.getByRole('dialog')).toHaveCount(0)
    // Never a blank first load without a word (§1.8 step 3's aim): Local Data offers it.
    expect(
        await next.evaluate(async () => {
            const { loadEvents } =
                (await import('/src/local/startup/events.ts')) as typeof import('../../src/local/startup/events')
            return loadEvents.value
        }),
    ).toContainEqual({ kind: 'migrationFailed', unreadable: true })
    expect(
        await next.evaluate(
            (prefix) => localStorage.getItem(`${prefix}autoSave.levelData`),
            prefix,
        ),
    ).toBe(future)
})

test('the session’s source name survives speculative edits, committed edits, undo and redo', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { history, fixtures, store } = window.editorTest
        const { planEdit } = await import('/src/state/operations/properties/plan.ts')
        const { editSelectedEditableEntities } =
            await import('/src/editor/sidebars/default/index.ts')
        const { filename } = await import('/src/history/filename.ts')
        history.resetState(false, fixtures.interaction, 0, { sourceName: 'named-chart' })
        const note = [...store.getAllEntities()].find((entity) => entity.type === 'note')!
        history.replaceState({ ...history.state.value, selectedEntities: [note] })
        const source = history.state.value
        const speculative = planEdit(source, [note], { size: 3 }).state
        const snapshot = () => ({
            filename: filename.value,
            size: [...store.getAllEntities()]
                .filter((entity) => entity.type === 'note')
                .find((entity) => entity.beat === 3)!.size,
        })
        editSelectedEditableEntities({ size: 3 })
        const committed = snapshot()
        history.undoState()
        const undone = snapshot()
        const sourceRestored = history.state.value === source
        history.redoState()
        return {
            inState: 'filename' in speculative || 'filename' in source,
            sourceRestored,
            committed,
            undone,
            redone: snapshot(),
        }
    })
    expect(result).toEqual({
        inState: false,
        sourceRestored: true,
        committed: { filename: 'named-chart', size: 3 },
        undone: { filename: 'named-chart', size: 2 },
        redone: { filename: 'named-chart', size: 3 },
    })
})

test('closing before the flush keeps colored notes, connectors and chart metadata: a new visit continues them, and its reload too', async ({
    page,
}) => {
    const expected = await page.evaluate(async () => {
        const { history, fixtures, settings, view } = window.editorTest
        const { editSelectedEditableEntities } =
            await import('/src/editor/sidebars/default/index.ts')
        const { serializeToLevelData } = await import('/src/levelData/serialize.ts')
        const base = fixtures.interaction.slides[0]![0]!
        history.resetState(
            false,
            {
                ...fixtures.interaction,
                slides: [
                    [{ ...base, beat: 2, left: 1 }],
                    [
                        { ...base, beat: 1 },
                        { ...base, beat: 3 },
                    ],
                ],
            },
            0.125,
            { sourceName: 'colored-chart' },
        )
        const notes = [...history.state.value.store.slides.note.values()].flat()
        history.replaceState({ ...history.state.value, selectedEntities: notes })
        editSelectedEditableEntities({ noteStyle: 'blue', connectorStyle: 'purple' })
        history.replaceState({ ...history.state.value, selectedEntities: [] })
        Object.assign(view, { time: 0, lane: 0, cursorTime: 0, hoverTime: 0 })
        settings.previewNoteSpeed = 11.25
        settings.previewControls = 'collapsed'
        settings.defaultNotePropertiesPresets = settings.defaultNotePropertiesPresets.map(
            (preset, i) =>
                i === 0 ? { ...preset, noteStyle: 'cyan', connectorStyle: 'black' } : preset,
        )
        const s = history.state.value
        return serializeToLevelData(
            s.initialLife,
            s.isDynamicStages,
            s.bgm.offset,
            s.store,
            s.groups,
            s.stages,
        )
    })
    const beforeClose = await canvasColors(page)
    expect(beforeClose.blue).toBeGreaterThan(100)
    expect(beforeClose.purple).toBeGreaterThan(100)
    page.on('dialog', (dialog) => void dialog.accept())
    const context = page.context()
    await closePage(page, { runBeforeUnload: true })
    const reopened = await context.newPage()
    await reopened.goto('/')
    await opened(reopened)
    await expect
        .poll(() => openLevel(reopened))
        .toEqual({ filename: 'colored-chart', data: expected })
    expect(
        await reopened.evaluate(async () => {
            const { settings } = await import('/src/settings.ts')
            return {
                speed: settings.previewNoteSpeed,
                controls: settings.previewControls,
                preset: settings.defaultNotePropertiesPresets[0],
            }
        }),
    ).toMatchObject({
        speed: 11.25,
        controls: 'collapsed',
        preset: { noteStyle: 'cyan', connectorStyle: 'black' },
    })
    expect(await canvasColors(reopened)).toEqual(beforeClose)
    reopened.on('dialog', (dialog) => void dialog.accept())
    await reopened.reload()
    await opened(reopened)
    await expect
        .poll(() => openLevel(reopened))
        .toEqual({ filename: 'colored-chart', data: expected })
    await expect.poll(() => canvasColors(reopened)).toEqual(beforeClose)
    await reopened.close()
})

test('a closed tab keeps the default guide color, without adding it to exported levels', async ({
    page,
}) => {
    await page.evaluate(() => {
        const { history, fixtures } = window.editorTest
        const base = { ...fixtures.interaction.slides[0]![0]!, connectorType: 'guide' as const }
        history.resetState(
            true,
            {
                ...fixtures.interaction,
                slides: [
                    [
                        { ...base, beat: 1 },
                        { ...base, beat: 2, connectorStyle: 'green' },
                    ],
                    // Unnamed standalone notes are moved before named slides on import.
                    [{ ...base, beat: 3, connectorStyle: 'blue' }],
                    [{ ...base, beat: 4 }],
                    [
                        { ...base, beat: 5, connectorStyle: 'green' },
                        { ...base, beat: 6 },
                    ],
                ],
            },
            0,
            { sourceName: 'guide-colors' },
        )
    })
    page.on('dialog', (dialog) => void dialog.accept())
    const context = page.context()
    await closePage(page, { runBeforeUnload: true })
    const reopened = await context.newPage()
    await reopened.goto('/')
    await opened(reopened)
    await expect
        .poll(() =>
            reopened.evaluate(async () => {
                const { state } =
                    (await import('/src/history/index.ts')) as typeof import('../../src/history')
                return [...state.value.store.slides.note.values()]
                    .flat()
                    .sort((a, b) => a.beat - b.beat)
                    .map(({ beat, connectorStyle }) => ({ beat, connectorStyle }))
            }),
        )
        .toEqual([
            { beat: 1, connectorStyle: 'default' },
            { beat: 2, connectorStyle: 'green' },
            { beat: 3, connectorStyle: 'blue' },
            { beat: 4, connectorStyle: 'default' },
            { beat: 5, connectorStyle: 'green' },
            { beat: 6, connectorStyle: 'default' },
        ])
    const exported = (await openLevel(reopened)).data
    const kinds = exported.entities.flatMap((entity) =>
        entity.data
            .filter(({ name }) => name === 'segmentKind')
            .map((data) => ('value' in data ? data.value : undefined)),
    )
    expect(kinds.sort()).toEqual([103, 103, 103, 103, 103, 104])
    expect(exported).not.toHaveProperty('defaultGuideColors')
    await reopened.close()
})

test('hiding the page journals pending color edits at once, without waiting for the flush', async ({
    page,
}) => {
    await page.evaluate(() => {
        const { history, fixtures } = window.editorTest
        history.resetState(false, fixtures.interaction, 0, { sourceName: 'named-chart' })
    })
    await stallFlushes(page)
    await page.evaluate(async () => {
        const { history, store } = window.editorTest
        const { editSelectedEditableEntities } =
            await import('/src/editor/sidebars/default/index.ts')
        const notes = [...store.getAllEntities()].filter((entity) => entity.type === 'note')
        history.replaceState({ ...history.state.value, selectedEntities: notes })
        editSelectedEditableEntities({ noteStyle: 'cyan', connectorStyle: 'black' })
    })
    expect(await journalLevel(page)).toBeUndefined()
    await hidePage(page)
    const saved = await journalLevel(page)
    expect(
        saved?.entities.some((entity) =>
            entity.data.some((field) => field.name === 'style' && field.value === 7),
        ),
    ).toBe(true)
})

test('charts above the former entity limit still journal all their colored notes', async ({
    page,
}) => {
    await stallFlushes(page)
    await page.evaluate(() => {
        const { history, fixtures } = window.editorTest
        const source = fixtures.interaction
        const base = source.slides[0]![0]!
        history.resetState(
            true,
            {
                ...source,
                slides: Array.from({ length: 10001 }, (_, i) => [
                    { ...base, beat: i, noteStyle: 'blue' },
                ]),
            },
            0,
            { sourceName: 'large-colored-chart' },
        )
    })
    await hidePage(page)
    const saved = await journalLevel(page)
    expect(
        saved?.entities.filter((entity) =>
            entity.data.some((field) => field.name === 'style' && field.value === 4),
        ).length,
    ).toBe(10001)
})

for (const { label, crash } of [
    { label: 'both tabs close', crash: false },
    { label: 'the first tab closes and the other crashes', crash: true },
])
    test(`work continued in a new tab survives when ${label}`, async ({ page }) => {
        const lifeOf = (tab: Page) =>
            tab.evaluate(async () => {
                const pathname = '/src/history/index.ts'
                const url =
                    performance
                        .getEntriesByType('resource')
                        .map((entry) => entry.name)
                        .find((name) => new URL(name).pathname === pathname) ?? pathname
                const { state } = (await import(url)) as typeof import('../../src/history')
                return state.value.initialLife
            })
        const context = page.context()
        await page.evaluate(() => {
            const { history, fixtures } = window.editorTest
            history.resetState(false, fixtures.interaction, 0, { sourceName: 'named-chart' })
            history.pushState(
                window.editorTest.historySteps.initialLife(history.state.value.initialLife, 990),
                { ...history.state.value, initialLife: 990 },
            )
        })
        page.on('dialog', (dialog) => void dialog.accept())
        await closePage(page, { runBeforeUnload: true })

        // A new tab continues it, and the user goes on there.
        const other = await context.newPage()
        if (crash)
            // A crash runs none of its unload or hide handlers.
            await other.addInitScript(() => {
                const add = EventTarget.prototype.addEventListener
                EventTarget.prototype.addEventListener = function (type, ...rest) {
                    if (['pagehide', 'beforeunload', 'visibilitychange', 'freeze'].includes(type))
                        return
                    add.call(this, type, ...rest)
                }
            })
        await other.goto('/')
        await opened(other)
        await expect.poll(() => lifeOf(other)).toBe(990)
        await expect(other.getByRole('dialog')).toHaveCount(0)
        await other.evaluate(async () => {
            const pathname = '/src/history/index.ts'
            const url =
                performance
                    .getEntriesByType('resource')
                    .map((entry) => entry.name)
                    .find((name) => new URL(name).pathname === pathname) ?? pathname
            const { pushState, state } = (await import(url)) as typeof import('../../src/history')
            const { initialLife } =
                (await import('/tests/helpers/historySteps.ts')) as typeof import('../helpers/historySteps')
            pushState(initialLife(state.value.initialLife, 980), {
                ...state.value,
                initialLife: 980,
            })
        })
        // Without handlers, only the flush stores it, about 1 s after the edit: wait until the
        // flusher has nothing waiting. The edit is waiting from the moment it is made.
        if (crash) {
            expect(await waiting(other)).toBeGreaterThan(0)
            await expect.poll(() => waiting(other), { timeout: 15_000 }).toBe(0)
        }
        other.on('dialog', (dialog) => void dialog.accept())
        await closePage(other, { runBeforeUnload: !crash })

        const reopened = await context.newPage()
        await reopened.goto('/')
        await opened(reopened)
        await expect.poll(() => lifeOf(reopened)).toBe(980)
    })

test('undoing dynamic stages leaves the event tools, whose events it could not save', async ({
    page,
}) => {
    const command = page.evaluate(async () => {
        const { appImport, history } = window.editorTest
        history.resetState(false)
        const { cameraEvent } = await appImport<
            typeof import('../../src/editor/commands/events/camera')
        >('/src/editor/commands/events/camera/index.ts')
        await cameraEvent.execute()
    })
    await expect(page.getByRole('dialog')).toBeVisible()
    await confirmWhenReady(
        page.getByRole('dialog').getByRole('button', { name: 'Confirm' }),
        page.getByRole('dialog'),
    )
    await command
    const tool = () =>
        page.evaluate(async () => {
            const { toolName } = await window.editorTest.appImport<
                typeof import('../../src/editor/tools/state')
            >('/src/editor/tools/state.ts')
            return toolName.value
        })
    expect(await tool()).toBe('cameraEvent')

    await page.keyboard.press('Control+z')
    expect(await page.evaluate(() => window.editorTest.history.state.value.isDynamicStages)).toBe(
        false,
    )
    await expect.poll(tool).toBe('select')
    const { x, y } = await page.evaluate(() => window.editorTest.point(0, 6))
    await page.mouse.click(x, y)
    expect(
        await page.evaluate(
            () =>
                [...window.editorTest.store.getAllEntities()].filter(
                    (entity) => entity.type === 'cameraEventJoint',
                ).length,
        ),
    ).toBe(0)
})

for (const dialog of ['properties', 'bgm'] as const)
    test(`confirming the ${dialog} dialog unchanged adds no history entry`, async ({ page }) => {
        await page.evaluate(() => {
            const { history, fixtures } = window.editorTest
            history.resetState(false, fixtures.interaction, 0.0041, { sourceName: 'clean-chart' })
        })
        const command = page.evaluate(async (dialog) => {
            const { commands } = await window.editorTest.appImport<
                typeof import('../../src/editor/commands')
            >('/src/editor/commands/index.ts')
            await commands[dialog].execute()
        }, dialog)
        await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click()
        await command
        await expect(page.getByRole('dialog')).toHaveCount(0)
        // The command has finished. Let the page draw twice, so nothing it queued is still to run.
        await page.evaluate(
            () =>
                new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
        )
        expect(
            await page.evaluate(() => ({
                canUndo: window.editorTest.history.canUndo.value,
                isDirty: window.editorTest.history.isDirty.value,
            })),
        ).toEqual({ canUndo: false, isDirty: false })
    })
