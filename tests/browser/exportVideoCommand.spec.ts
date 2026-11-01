import { expect, test, type Page } from '@playwright/test'
import en from '../../src/i18n/en/index.json' with { type: 'json' }
import { installCanvasCounters, installEditorFixture } from './editorFixture'

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
