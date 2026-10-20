import { expect, test, type Page } from '@playwright/test'
import { waitForStartup } from './editorFixture'
import {
    builds,
    chainOf,
    edit,
    notice,
    preparingDialog,
    pressSave,
    rows,
    saveDialog,
    saveReserved,
    sessionOf,
    start,
    submitSave,
} from './saveFlows'

// Saving where there's no save picker (Part 1 §1.4.7; Firefox, WebKit, and Chromium with the
// override's `fileSystemAccess: false`): the first Save shows the dialog with the download note
// and downloads; later Saves download with no dialog; an unchanged one offers Download Again; no
// conflict dialog ever shows. The compatibility config's storage projects run it in Firefox and
// WebKit.

const saves = async (page: Page) =>
    (await rows(page, ['entries'])).entries!.filter((row) => row.value.kind === 'save').length

const downloaded = async (page: Page, run: () => Promise<void>) => {
    const downloading = page.waitForEvent('download')
    await run()
    return (await downloading).suggestedFilename()
}

test('a download browser: the first Save asks once, later Saves download, unchanged asks first', async ({
    page,
}) => {
    await start(page, { fileSystemAccess: false })
    await edit(page, 1)
    const first = await downloaded(page, async () => {
        await pressSave(page)
        await expect(saveDialog(page)).toContainText('Each save downloads a new copy.')
        await submitSave(page, 'coconut')
    })
    expect(first).toBe('coconut.nxsp')
    await expect(notice(page).filter({ hasText: 'Download started: coconut.nxsp' })).toBeVisible()
    await expect
        .poll(async () => (await chainOf(page)).file)
        .toMatchObject({
            name: 'coconut.nxsp',
            event: 'downloaded',
        })
    expect((await sessionOf(page)).file).toMatchObject({ event: 'downloaded' })

    // Unchanged: a repeated p piles up no copies.
    await pressSave(page)
    const unchanged = notice(page).filter({
        hasText: 'No changes since coconut.nxsp was downloaded',
    })
    await expect(unchanged).toBeVisible()
    const again = await downloaded(page, async () => {
        await unchanged.getByRole('button', { name: 'Download Again' }).click()
    })
    expect(again).toBe('coconut.nxsp')

    // A change downloads with no dialog.
    await edit(page, 2)
    // That Save has recorded its download before the next press.
    await expect.poll(() => saves(page)).toBe(2)
    const second = await downloaded(page, () => pressSave(page))
    expect(second).toBe('coconut.nxsp')
    await expect(saveDialog(page)).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // A later session's first Save shows no download note.
    await page.reload()
    await waitForStartup(page)
    await page.evaluate(async () => {
        const { resetState } = await import('/src/history/index.ts')
        resetState(false)
    })
    await edit(page, 3)
    await pressSave(page)
    await expect(saveDialog(page)).toBeVisible()
    await expect(saveDialog(page)).not.toContainText('Each save downloads a new copy.')
})

test('Download Again pressed after another session opened downloads nothing and binds nothing', async ({
    page,
}) => {
    await start(page, { fileSystemAccess: false })
    await edit(page, 1)
    await downloaded(page, async () => {
        await pressSave(page)
        await submitSave(page, 'coconut')
    })
    await expect.poll(async () => (await chainOf(page)).file).toMatchObject({ event: 'downloaded' })
    // The notice's Download Again, kept to press later.
    await page.evaluate(async () => {
        const { setSaveUiForTests } = await import('/src/editor/save/dialogs.ts')
        setSaveUiForTests({
            noChanges: (_name, _event, again) => {
                ;(window as { again?: () => void }).again = again
            },
        })
    })
    await pressSave(page)
    await expect
        .poll(() => page.evaluate(() => typeof (window as { again?: unknown }).again))
        .toBe('function')
    // Another session opens in this tab before the press.
    await page.evaluate(async () => {
        const { resetState } = await import('/src/history/index.ts')
        resetState(false)
    })
    await edit(page, 2)
    let downloads = 0
    page.on('download', () => downloads++)
    await page.evaluate(() => (window as { again?: () => void }).again?.())
    await page.waitForTimeout(1000)
    expect(downloads).toBe(0)
    expect((await sessionOf(page)).file).toBeUndefined()
})

test('opening a file this browser downloaded confirms its downloads', async ({ page }) => {
    await start(page, {
        fileSystemAccess: false,
        override: { os: 'linux', engine: 'firefox' },
    })
    await edit(page, 1)
    const downloading = page.waitForEvent('download')
    await pressSave(page)
    await submitSave(page, 'coconut')
    const download = await downloading
    await expect(page.locator('[data-file-chip="notConfirmed"]')).toBeVisible()
    const bytes = [...(await import('node:fs')).readFileSync((await download.path())!)]
    await page.evaluate(async (bytes) => {
        const { openProject } = await import('/src/editor/commands/open/project.ts')
        await openProject(new File([new Uint8Array(bytes)], 'coconut.nxsp'), undefined)
    }, bytes)
    await expect(notice(page).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    // Later downloads are confirmed: no chip. The first Save after an open asks (§1.4.7).
    await edit(page, 2)
    await downloaded(page, async () => {
        await pressSave(page)
        await submitSave(page)
    })
    await expect(page.locator('[data-file-chip]')).toHaveCount(0)
})

test('a download browser never requests nse-bind', async ({ page }) => {
    await page.addInitScript(() => {
        const names: string[] = []
        ;(window as { lockNames?: string[] }).lockNames = names
        const request = LockManager.prototype.request
        LockManager.prototype.request = function (
            this: LockManager,
            name: string,
            ...rest: unknown[]
        ) {
            names.push(name)
            return (request as (...args: unknown[]) => Promise<unknown>).call(this, name, ...rest)
        } as typeof request
    })
    await start(page, { fileSystemAccess: false })
    await edit(page, 1)
    await downloaded(page, async () => {
        await pressSave(page)
        await submitSave(page, 'coconut')
    })
    await edit(page, 2)
    await downloaded(page, () => pressSave(page))
    const names = await page.evaluate(() => (window as { lockNames?: string[] }).lockNames ?? [])
    expect(names.length).toBeGreaterThan(0)
    expect(names).not.toContain('nse-bind')
})

test('Cancel in a slow Preparing… ends the Save: nothing asks or downloads, and the next Save runs (SF-2)', async ({
    page,
}) => {
    // Every press's activation has lapsed, so each download asks for its own tap.
    await start(page, { fileSystemAccess: false, override: { activation: false } })
    await edit(page, 1)
    await downloaded(page, async () => {
        await pressSave(page)
        await submitSave(page, 'coconut')
        await preparingDialog(page).getByRole('button', { name: 'Download' }).click()
    })
    await expect.poll(async () => (await chainOf(page)).file).toMatchObject({ event: 'downloaded' })
    await edit(page, 2)
    await builds(page, 2500)
    let downloads = 0
    page.on('download', () => downloads++)
    await pressSave(page)
    await preparingDialog(page).getByRole('button', { name: 'Cancel' }).click()
    await expect(preparingDialog(page)).toHaveCount(0)
    // The build ends after the Cancel: nothing asks, nothing downloads, nothing stays reserved.
    await page.waitForTimeout(2500)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(downloads).toBe(0)
    await expect.poll(() => saveReserved(page)).toBe(false)
    await builds(page, undefined)
    const next = await downloaded(page, async () => {
        await pressSave(page)
        await preparingDialog(page).getByRole('button', { name: 'Download' }).click()
    })
    expect(next).toBe('coconut.nxsp')
})
