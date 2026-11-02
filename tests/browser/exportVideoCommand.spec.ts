import { expect, test, type Page } from '@playwright/test'
import en from '../../src/i18n/en/index.json' with { type: 'json' }
import { installCanvasCounters, installEditorFixture, waitForStartup } from './editorFixture'
import { openVideoDialog } from './exportVideoDialog'
import { wav } from './levelInfoFiles'

// The Export Video command: the toolbar opens it, a peek exports the step on screen, a browser
// without the encoders gets a notice, and the toolbar step adds it to the old first group.

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Export Video', exact: true })
const outField = (page: Page) => dialog(page).getByRole('textbox', { name: 'Out' })

const start = async (page: Page) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
}

const run = (page: Page) =>
    page.evaluate(async () => {
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        const { commands } = await import('/src/editor/commands/index.ts')
        void runCommand(commands.exportVideo, 'button')
    })

/** Shows a chart whose last note is at `beat`, at 120 BPM. */
const showUntil = (page: Page, beat: number) =>
    page.evaluate((beat) => {
        const { fixtures, show } = window.editorTest
        const chart = structuredClone(fixtures.interaction)
        const [base] = chart.slides[0] ?? []
        if (!base) throw new Error('No note')
        chart.slides = [[{ ...base, beat: 0 }], [{ ...base, beat }]]
        show(chart)
    }, beat)

test('the File group opens it, and Escape closes it', async ({ page }) => {
    await start(page)
    await page.locator('[data-editor-toolbar] button[title="Open…"]').hover()
    await page
        .locator(`[data-editor-toolbar] button[title="${en.commands.exportVideo.title}"]`)
        .click()
    await expect(dialog(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
})

test('a reload defaults to Whole BGM and uses Whole Chart after BGM removal', async ({ page }) => {
    test.slow()
    await page.goto('/')
    await waitForStartup(page)
    await page.evaluate(installEditorFixture)
    await page.evaluate(() => window.editorTest.show(window.editorTest.fixtures.notes))
    await page.keyboard.press('m')
    const bgm = page.getByRole('dialog', { name: 'BGM', exact: true })
    const audio = bgm.locator('input[type="button"]')
    const choosing = page.waitForEvent('filechooser')
    await audio.click()
    await (
        await choosing
    ).setFiles({
        name: 'reload.wav',
        mimeType: 'audio/wav',
        buffer: wav(12),
    })
    await expect(audio).toHaveValue(/^00:12/)
    await bgm.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(bgm).toHaveCount(0)

    const flush = () =>
        page.evaluate(async () => {
            const { flusher } =
                (await import('/src/local/storing.ts')) as typeof import('../../src/local/storing')
            if (!flusher) throw new Error('No flusher')
            await flusher.flush({ strict: true })
        })
    const chain = () =>
        page.evaluate(async () => {
            const { session } =
                (await import('/src/history/session.ts')) as typeof import('../../src/history/session')
            return session.value.docId
        })
    await flush()
    const before = await chain()
    let exportDialog = await openVideoDialog(page)
    await exportDialog.locator('[data-export-range]').click()
    await exportDialog.getByRole('menuitemradio', { name: 'Whole BGM' }).click()
    await expect(exportDialog.getByRole('textbox', { name: 'Out', exact: true })).toHaveValue(
        '00:12.000',
    )
    // Whole Chart distinguishes a reset to the default from a remembered Whole BGM choice.
    await exportDialog.locator('[data-export-range]').click()
    await exportDialog.getByRole('menuitemradio', { name: 'Whole Chart' }).click()
    await page.keyboard.press('Escape')
    await expect(exportDialog).toHaveCount(0)

    await page.reload()
    await waitForStartup(page)
    expect(await chain()).toBe(before)
    await page.evaluate(async () => {
        const { settleHeldBgm } =
            (await import('/src/editor/media/heldBgm.ts')) as typeof import('../../src/editor/media/heldBgm')
        await settleHeldBgm()
    })
    exportDialog = await openVideoDialog(page)
    await expect(exportDialog.getByRole('textbox', { name: 'Out', exact: true })).toHaveValue(
        '00:12.000',
    )
    await exportDialog.locator('[data-export-range]').click()
    await expect(exportDialog.getByRole('menuitemradio', { name: 'Whole BGM' })).toHaveAttribute(
        'aria-checked',
        'true',
    )
    await exportDialog.getByRole('menuitemradio', { name: 'Whole BGM' }).click()
    await page.keyboard.press('Escape')
    await expect(exportDialog).toHaveCount(0)

    // Undo the BGM addition before storing and reloading the same chart again.
    await page.locator('canvas.editor-chart').focus()
    await page.keyboard.press('Control+z')
    await expect
        .poll(() =>
            page.evaluate(async () => {
                const { liveState } =
                    (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
                return !!liveState.value.bgm.meta || !!liveState.value.bgm.buffer
            }),
        )
        .toBe(false)
    await flush()
    await page.reload()
    await waitForStartup(page)
    expect(await chain()).toBe(before)
    exportDialog = await openVideoDialog(page)
    await expect(exportDialog.getByRole('textbox', { name: 'Out', exact: true })).toHaveValue(
        '00:09.500',
    )
    await exportDialog.locator('[data-export-range]').click()
    await expect(exportDialog.getByRole('menuitemradio')).toHaveText(['Whole Chart', 'Selection'])
    await expect(exportDialog.getByRole('menuitemradio', { name: 'Whole Chart' })).toHaveAttribute(
        'aria-checked',
        'true',
    )
})

test('while peeking, it runs and takes the chart of the step on screen', async ({ page }) => {
    await start(page)
    await showUntil(page, 8)
    await run(page)
    const peekedOut = await outField(page).inputValue()
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    await page.evaluate(async () => {
        const { state } =
            await window.editorTest.appImport<typeof import('../../src/history/stack')>(
                '/src/history/stack.ts',
            )
        Reflect.set(window, 'peekedState', state.value)
    })
    await showUntil(page, 40)
    await run(page)
    const liveOut = await outField(page).inputValue()
    expect(liveOut).not.toBe(peekedOut)
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)

    await page.evaluate(async () => {
        const { peek } =
            await window.editorTest.appImport<typeof import('../../src/history/stack')>(
                '/src/history/stack.ts',
            )
        peek.value = { source: 'test', state: Reflect.get(window, 'peekedState') }
    })
    await run(page)
    await expect(outField(page)).toHaveValue(peekedOut)
})

for (const missing of ['VideoEncoder', 'AudioEncoder']) {
    test(`without ${missing}, it shows a notice and no dialog`, async ({ page }) => {
        const workers: string[] = []
        page.on('worker', (worker) => workers.push(worker.url()))
        await page.addInitScript((missing) => Reflect.deleteProperty(window, missing), missing)
        await start(page)
        await run(page)
        await expect(
            page.locator('.notification', { hasText: en.exportVideo.unsupported }),
        ).toBeVisible()
        await expect(page.locator('dialog:has([data-export-form])')).toHaveCount(0)
        expect(workers.filter((url) => url.includes('export.worker'))).toEqual([])
    })
}

test('the toolbar step adds Export Video to the old first group once, and a removal stays', async ({
    page,
}) => {
    const former = [
        'utilities',
        'statistics',
        'properties',
        'reset',
        'exportLevel',
        'saveAs',
        'save',
        'open',
    ]
    await page.addInitScript(installCanvasCounters)
    await page.addInitScript((former) => {
        if (sessionStorage.getItem('seeded')) return
        sessionStorage.setItem('seeded', '1')
        const prefix = 'sonolus-next-sekai-editor.'
        localStorage.setItem(`${prefix}toolbar`, JSON.stringify([former, ['play']]))
        // The earlier steps are done, so only this one is seen.
        for (const flag of [
            'toolbarEditorLayoutMigrated',
            'toolbarExportMigrated',
            'toolbarPreviewAssetsMigrated',
            'toolbarSessionRestoreMigrated',
            'toolbarMinimapMigrated',
            'toolbarStatisticsMigrated',
        ])
            localStorage.setItem(`${prefix}${flag}`, 'true')
        localStorage.removeItem(`${prefix}toolbarExportVideoMigrated`)
    }, former)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    const toolbar = () => page.evaluate(() => window.editorTest.settings.toolbar)
    const at = former.indexOf('exportLevel')
    const withVideo = [...former.slice(0, at), 'exportVideo', ...former.slice(at)]
    expect(await toolbar()).toEqual([withVideo, ['play']])
    expect(
        await page.evaluate(() => [
            localStorage.getItem('sonolus-next-sekai-editor.toolbarExportVideoMigrated'),
            JSON.parse(localStorage.getItem('sonolus-next-sekai-editor.toolbar') ?? '[]')[0],
        ]),
    ).toEqual(['true', withVideo])

    // Removing it afterwards is a customisation, kept across a reload.
    await page.evaluate(() => {
        const { settings } = window.editorTest
        settings.toolbar = settings.toolbar.map((group) =>
            group.filter((name) => name !== 'exportVideo'),
        )
    })
    await page.reload()
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    expect((await toolbar())[0]).toEqual(former)
})
