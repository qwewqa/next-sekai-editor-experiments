import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'
import { edit, flushed, notice, pressSave, queuePicks, start, submitSave } from './saveFlows'

test('export events capture delivery and fallback once while known descriptions follow the current locale', async ({
    page,
}) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    const result = await page.evaluate(async () => {
        const app = window.editorTest
        const stack =
            await app.appImport<typeof import('../../src/history/stack')>('/src/history/stack.ts')
        const markers =
            await app.appImport<typeof import('../../src/history/markers')>(
                '/src/history/markers.ts',
            )
        const actions =
            await app.appImport<typeof import('../../src/history/actions')>(
                '/src/history/actions.ts',
            )
        const operations = await app.appImport<typeof import('../../src/history/operations')>(
            '/src/history/operations/index.ts',
        )
        const presentation = await app.appImport<
            typeof import('../../src/history/operationPresentation/format')
        >('/src/history/operationPresentation/format.ts')
        const factory = await app.appImport<
            typeof import('../../src/history/createHistoryOperation')
        >('/src/history/createHistoryOperation.ts')
        const oldLocale = app.settings.locale
        try {
            app.settings.locale = 'en'
            const state = stack.liveState.value
            stack.resetStates({ state, step: app.historySteps.initialStep(), isDirty: false })
            stack.pushState(app.historySteps.initialLife(state.initialLife, 900), {
                ...state,
                initialLife: 900,
            })
            const head = stack.headStep.value
            const seen: import('../../src/history/actions').HistoryAction[] = []
            const stop = actions.onHistoryAction((action) => seen.push(action))
            markers.markExported('Coconut.nsld', 'file')
            markers.markExported('Coconut.nsld', 'download')
            stop()
            const descriptions = seen.map((action) => operations.captureEntryDescription(action))
            const raw = descriptions.map(operations.entryOperation)
            const captured = JSON.stringify(raw)
            const english = raw.map((operation) =>
                presentation.describeCapturedOperation(
                    operation,
                    'File Event',
                    factory.getHistoryOperationContext(),
                ),
            )
            app.settings.locale = 'fr'
            await app.nextTick()
            const french = raw.map((operation) =>
                presentation.describeCapturedOperation(
                    operation,
                    'File Event',
                    factory.getHistoryOperationContext(),
                ),
            )
            return {
                kinds: seen.map((action) => action.kind),
                dirty: seen.map((action) => action.isDirty),
                lives: seen.map((action) => action.state?.initialLife),
                operations: raw.map((operation) => {
                    const decoded = operations.decodeOperation(operation)
                    if (decoded.status !== 'known' || decoded.operation.id !== 'nse.file.export')
                        throw new Error('Unexpected marker')
                    return {
                        id: decoded.operation.id,
                        ...decoded.operation.data,
                        fallback: decoded.operation.fallback,
                    }
                }),
                english,
                french,
                stable: JSON.stringify(raw) === captured,
                sameHead: head === stack.headStep.value,
            }
        } finally {
            app.settings.locale = oldLocale
        }
    })
    expect(result.kinds).toEqual(['export', 'export'])
    expect(result.dirty).toEqual([true, true])
    expect(result.lives).toEqual([900, 900])
    expect(
        result.operations.map((operation) => [
            operation.id,
            operation.delivery,
            operation.file.text,
        ]),
    ).toEqual([
        ['nse.file.export', 'file', 'Coconut.nsld'],
        ['nse.file.export', 'download', 'Coconut.nsld'],
    ])
    expect(result.english).toEqual(['Exported Coconut.nsld', 'Exported Coconut.nsld'])
    expect(result.french[0]).toBe('Coconut.nsld export\u00e9')
    expect(result.french).not.toEqual(result.english)
    expect(result.stable).toBe(true)
    expect(result.sameHead).toBe(true)
    expect(errors).toEqual([])
})

/** The `save` entries a real Save stored, as the Timeline describes them in a locale. */
const savedDescriptions = (page: Page, locale: string) =>
    page.evaluate(async (locale) => {
        const { settings } =
            (await import('/src/settings.ts')) as typeof import('../../src/settings')
        const { nextTick } =
            (await import('/tests/helpers/vue.ts')) as typeof import('../helpers/vue')
        const operations =
            (await import('/src/history/operations/index.ts')) as typeof import('../../src/history/operations')
        const presentation =
            (await import('/src/history/operationPresentation/format.ts')) as typeof import('../../src/history/operationPresentation/format')
        const factory =
            (await import('/src/history/createHistoryOperation.ts')) as typeof import('../../src/history/createHistoryOperation')
        const rows = (await window.nseStorageTest!.worker.call('testRows', [
            'entries',
        ])) as unknown as {
            entries: { value: { kind: string; operation: never } }[]
        }
        const old = settings.locale
        try {
            settings.locale = locale as typeof settings.locale
            await nextTick()
            return rows.entries
                .filter((row) => row.value.kind === 'save')
                .map((row) => {
                    const decoded = operations.decodeOperation(row.value.operation)
                    return {
                        id: decoded.status === 'known' ? decoded.operation.id : decoded.status,
                        text: presentation.describeCapturedOperation(
                            row.value.operation,
                            'File Event',
                            factory.getHistoryOperationContext(),
                        ),
                    }
                })
        } finally {
            settings.locale = old
        }
    }, locale)

test('a real Save stores its save entry with the delivery, described in the current locale', async ({
    page,
    browser,
}) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await start(page)
    await edit(page, 1)
    await queuePicks(page, ['Coconut.nxsp'])
    await pressSave(page)
    await submitSave(page, 'Coconut')
    await expect(notice(page).filter({ hasText: 'Saved to Coconut.nxsp' })).toBeVisible()
    await flushed(page)
    expect(await savedDescriptions(page, 'en')).toEqual([
        { id: 'nse.file.save', text: 'Saved Coconut.nxsp' },
    ])
    const french = await savedDescriptions(page, 'fr')
    expect(french).toHaveLength(1)
    expect(french[0]!.text).not.toBe('Saved Coconut.nxsp')

    // A browser with no save picker downloads: the entry says so.
    const context = await browser.newContext()
    try {
        const other = await context.newPage()
        other.on('pageerror', (error) => errors.push(error.message))
        await start(other, { fileSystemAccess: false })
        await edit(other, 1)
        const downloading = other.waitForEvent('download')
        await pressSave(other)
        await submitSave(other, 'Coconut')
        expect((await downloading).suggestedFilename()).toBe('Coconut.nxsp')
        await flushed(other)
        expect(await savedDescriptions(other, 'en')).toEqual([
            { id: 'nse.file.save', text: 'Downloaded Coconut.nxsp' },
        ])
    } finally {
        await context.close()
    }
    expect(errors).toEqual([])
})
