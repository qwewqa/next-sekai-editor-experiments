import { expect, test, type Page } from '@playwright/test'
import { executePlan, planNxsp } from '../../src/local/nxsp'
import { fresh } from '../local/nxsp/chain'
import {
    chainOf,
    edit,
    notice,
    pressSave,
    readFile,
    saveDialog,
    sessionOf,
    start,
    submitSave,
    writeFile,
} from './saveFlows'

// A tab left open across a deploy, or one without a connection, cannot load the Save code. The
// code loads in the background once startup is over (the warm-up); a press that finds it missing
// says so. The warm-up also loads the History code before first use.

const FLOW = '**/src/editor/save/flow.ts*'
const failed = 'This could not be completed.'

const errors = new WeakMap<Page, string[]>()

test.beforeEach(({ page }) => {
    const seen: string[] = []
    errors.set(page, seen)
    page.on('pageerror', (error) => seen.push(error.message))
})

test.afterEach(({ page }) => {
    // A failed warm-up load is silent.
    expect(errors.get(page)).toEqual([])
})

test('Save and Save As… say so when their code does not load, and change nothing', async ({
    page,
}) => {
    await page.route(FLOW, (route) => route.abort())
    await start(page)
    await edit(page, 1)
    const before = await sessionOf(page)

    await pressSave(page)
    await expect(notice(page).filter({ hasText: failed })).toBeVisible()
    await expect(saveDialog(page)).toHaveCount(0)
    expect(await sessionOf(page)).toEqual(before)

    await page.evaluate(async () => {
        const { saveAs } =
            (await import('/src/editor/commands/saveAs/index.ts')) as typeof import('../../src/editor/commands/saveAs')
        await saveAs.execute()
    })
    await expect(notice(page).filter({ hasText: failed })).toBeVisible()
    await expect(saveDialog(page, 'Save As')).toHaveCount(0)
    expect(await sessionOf(page)).toEqual(before)
})

test('Save works after its chunk becomes unavailable, having been warmed up', async ({ page }) => {
    const loaded = new Set<string>()
    page.on('response', (response) => {
        const match = /\/src\/(editor\/save\/flow|editor\/save\/exportPick)\.ts/.exec(
            response.url(),
        )
        if (match?.[1]) loaded.add(match[1])
    })
    await start(page)
    // No edit yet: the first edit loads the code too, so this is the warm-up alone.
    await expect.poll(() => loaded.size, { timeout: 20_000 }).toBe(2)
    await page.route('**/src/editor/save/**', (route) => route.abort())
    await edit(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
})

test('the warm-up loads the History code before first use, and opening History fetches nothing', async ({
    page,
}) => {
    const modules: string[] = []
    page.on('request', (request) => {
        const { pathname } = new URL(request.url())
        if (/^\/src\/.*\.(ts|vue)$/.test(pathname)) modules.push(pathname)
    })
    await start(page)
    // The groups load in order, one idle slot each; the last is Preview Assets.
    await expect
        .poll(
            () => modules.some((path) => path.endsWith('/previewAssets/PreviewAssetsModal.vue')),
            {
                timeout: 30_000,
            },
        )
        .toBe(true)
    expect(modules.some((path) => path.endsWith('/history/HistoryPanel.vue'))).toBe(true)
    expect(modules.some((path) => path.endsWith('/history/StepDetailsModal.vue'))).toBe(true)

    // Settled, then History opens: its code is all there.
    await page.waitForTimeout(500)
    const before = modules.length
    await page.evaluate(async () => {
        const { openHistoryDialog } =
            (await import('/src/editor/history/openHistory.ts')) as typeof import('../../src/editor/history/openHistory')
        void openHistoryDialog('timeline')
    })
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.waitForTimeout(500)
    expect(modules.slice(before)).toEqual([])
})

test.describe('code that loads inside a Save', () => {
    // Save's own code loads; the code that keeps or opens the file on disk does not.
    for (const choice of ['Replace', 'Open the Other Version'])
        test(`${choice} says so when the project code does not load`, async ({ page }) => {
            await page.route('**/src/editor/commands/open/project.ts*', (route) => route.abort())
            await start(page)
            await edit(page, 1)
            await pressSave(page)
            await submitSave(page, 'coconut')
            await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
            await expect
                .poll(async () => (await chainOf(page)).file)
                .toMatchObject({ event: 'saved' })

            const other = [
                ...new Uint8Array(
                    await (
                        await executePlan(planNxsp(fresh().input).plan, new Map())
                    ).arrayBuffer(),
                ),
            ]
            await writeFile(page, 'coconut.nxsp', other)
            await edit(page, 2)
            await pressSave(page)
            const dialog = page.getByRole('dialog')
            await expect(dialog).toContainText('“coconut.nxsp” Changed')
            // Past the dialog's activation guard.
            await page.waitForTimeout(350)
            const session = await sessionOf(page)
            await dialog.getByRole('button', { name: choice }).click()
            await expect(notice(page).filter({ hasText: failed })).toBeVisible()
            // The file on disk is as it was, and so is the session.
            expect(await readFile(page, 'coconut.nxsp')).toEqual(other)
            expect(await sessionOf(page)).toEqual(session)
        })
})

test('Preview Assets says so when its code does not load', async ({ page }) => {
    await page.route('**/PreviewAssetsModal.vue*', (route) => route.abort())
    await start(page)
    await page.evaluate(async () => {
        const { showPreviewAssets } =
            (await import('/src/editor/commands/previewAssets/modal.ts')) as typeof import('../../src/editor/commands/previewAssets/modal')
        await showPreviewAssets()
    })
    await expect(notice(page).filter({ hasText: failed })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('Preview Assets opened with a package says so when the package reader does not load', async ({
    page,
}) => {
    await page.route('**/preview/assets/files/inspect.ts*', (route) => route.abort())
    await start(page)
    await page.evaluate(async () => {
        const { showPreviewAssets } =
            (await import('/src/editor/commands/previewAssets/modal.ts')) as typeof import('../../src/editor/commands/previewAssets/modal')
        await showPreviewAssets(undefined, { file: new File([new Uint8Array(4)], 'pack.scp') })
    })
    await expect(notice(page).filter({ hasText: failed })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('the docked History panel says so when its code does not load', async ({ page }) => {
    await page.route('**/history/HistoryPanel.vue*', (route) => route.abort())
    await start(page)
    const dock = page.locator('[data-workspace-dock="right"]')
    await dock.getByRole('tab', { name: 'History' }).click()
    await expect(dock.locator('[data-history-failed]')).toHaveText(
        'The Timeline could not be loaded.',
    )
})
