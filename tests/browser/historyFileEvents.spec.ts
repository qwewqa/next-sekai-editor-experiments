import { expect, test } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

test('file events capture delivery and fallback once while known descriptions follow the current locale', async ({page}) => {
    const errors:string[] = []
    page.on('pageerror',error=>errors.push(error.message))
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    const result = await page.evaluate(async () => {
        const app = window.editorTest
        const markers = await app.appImport<typeof import('../../src/history/markers')>('/src/history/markers.ts')
        const actions = await app.appImport<typeof import('../../src/history/actions')>('/src/history/actions.ts')
        const operations = await app.appImport<typeof import('../../src/history/operations')>('/src/history/operations/index.ts')
        const presentation = await app.appImport<typeof import('../../src/history/operationPresentation/format')>('/src/history/operationPresentation/format.ts')
        const factory = await app.appImport<typeof import('../../src/history/createHistoryOperation')>('/src/history/createHistoryOperation.ts')
        const oldLocale = app.settings.locale
        try {
            app.settings.locale = 'en'
            const state = app.history.liveState.value
            app.history.resetStates({state,step:app.historySteps.initialStep(),isDirty:false})
            app.history.pushState(app.historySteps.initialLife(state.initialLife,900),{...state,initialLife:900})
            const head = app.history.headStep.value
            const seen:import('../../src/history/actions').HistoryAction[] = []
            const stop = actions.onHistoryAction(action=>seen.push(action))
            markers.markExported('Coconut.nsld','file')
            markers.markExported('Coconut.nsld','download')
            markers.markSaved('Coconut.nxsp',false)
            markers.markSaved('Coconut.nxsp',true)
            stop()
            const descriptions = seen.map(action=>operations.captureEntryDescription(action))
            const raw = descriptions.map(operations.entryOperation)
            const captured = JSON.stringify(raw)
            const english = raw.map(operation=>presentation.describeCapturedOperation(operation,'File Event',factory.getHistoryOperationContext()))
            app.settings.locale = 'fr'
            await app.nextTick()
            const french = raw.map(operation=>presentation.describeCapturedOperation(operation,'File Event',factory.getHistoryOperationContext()))
            return {
                kinds:seen.map(action=>action.kind),
                dirty:seen.map(action=>action.isDirty),
                lives:seen.map(action=>action.state?.initialLife),
                operations:raw.map(operation=>{
                    const decoded = operations.decodeOperation(operation)
                    if (decoded.status !== 'known' || (decoded.operation.id !== 'nse.file.save' && decoded.operation.id !== 'nse.file.export')) throw new Error('Unexpected marker')
                    return {id:decoded.operation.id,...decoded.operation.data,fallback:decoded.operation.fallback}
                }),
                english,french,stable:JSON.stringify(raw)===captured,
                sameHead:head===app.history.headStep.value,
            }
        } finally {app.settings.locale=oldLocale}
    })
    expect(result.kinds).toEqual(['export','export','save','save'])
    expect(result.dirty).toEqual([true,true,false,false])
    expect(result.lives).toEqual([900,900,900,900])
    expect(result.operations.map(operation=>[operation.id,operation.delivery,operation.file.text])).toEqual([
        ['nse.file.export','file','Coconut.nsld'],['nse.file.export','download','Coconut.nsld'],
        ['nse.file.save','file','Coconut.nxsp'],['nse.file.save','download','Coconut.nxsp'],
    ])
    expect(result.english).toEqual(['Exported Coconut.nsld','Exported Coconut.nsld','Saved Coconut.nxsp','Downloaded Coconut.nxsp'])
    expect(result.french[0]).toBe('Coconut.nsld export?')
    expect(result.french).not.toEqual(result.english)
    expect(result.stable).toBe(true)
    expect(result.sameHead).toBe(true)
    expect(errors).toEqual([])
})
