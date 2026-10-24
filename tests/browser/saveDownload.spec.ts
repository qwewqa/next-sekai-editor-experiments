import { expect, test, type Page } from '@playwright/test'
import { waitForStartup } from './editorFixture'
import {
    builds,
    chainById,
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
import { skipWhereTheEditorCannotStart } from './webkitSupport'

// A WebKit build without OffscreenCanvas (Playwright's on Windows) cannot start the editor.
skipWhereTheEditorCannotStart()

// Saving where there's no save picker (Firefox, WebKit, and Chromium with the
// override's `fileSystemAccess: false`): the first Save shows the dialog
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
        await expect(saveDialog(page)).toBeVisible()
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

    // A later session's first Save asks again.
    await page.reload()
    await waitForStartup(page)
    await page.evaluate(async () => {
        const { resetState } = await import('/src/history/index.ts')
        resetState(false)
    })
    await edit(page, 3)
    await pressSave(page)
    await expect(saveDialog(page)).toBeVisible()
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
    // From a new session: opened from the session that wrote it, the download keeps that session.
    await page.evaluate(async (bytes) => {
        const { resetState } = await import('/src/history/index.ts')
        resetState(false)
        const { openProject } = await import('/src/editor/commands/open/project.ts')
        await openProject(new File([new Uint8Array(bytes)], 'coconut.nxsp'), undefined)
    }, bytes)
    await expect(notice(page).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    // Later downloads are confirmed: no chip. The first Save after an open asks.
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

test('Cancel in a slow Preparing… ends the Save: nothing asks or downloads, and the next Save runs', async ({
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

// Open of the file the open session last saved: no new chain, and the session
// stays; with work since the Save, today's open, a new chain with Reopen.

const chainCount = async (page: Page) => (await rows(page, ['chains'])).chains!.length

/** Saves a first download "coconut", and returns its bytes once its binding is recorded. */
const savedDownload = async (page: Page) => {
    await edit(page, 1)
    const downloading = page.waitForEvent('download')
    await pressSave(page)
    await submitSave(page, 'coconut')
    const download = await downloading
    await expect.poll(async () => (await chainOf(page)).file).toMatchObject({ event: 'downloaded' })
    return [...(await import('node:fs')).readFileSync((await download.path())!)]
}

const openBytes = (page: Page, bytes: number[], name: string) =>
    page.evaluate(
        async ({ bytes, name }) => {
            const { openProject } = await import('/src/editor/commands/open/project.ts')
            await openProject(new File([new Uint8Array(bytes)], name), undefined)
        },
        { bytes, name },
    )

test('opening the download just saved keeps the session: one chain, confirmed, no dialog next', async ({
    page,
}) => {
    await start(page, {
        fileSystemAccess: false,
        override: { os: 'linux', engine: 'firefox' },
    })
    const bytes = await savedDownload(page)
    const before = await chainOf(page)
    const { sessionId } = await sessionOf(page)
    await expect(page.locator('[data-file-chip="notConfirmed"]')).toBeVisible()

    // The browser renamed the second copy: the name is no fact, the write is.
    await openBytes(page, bytes, 'coconut (1).nxsp')
    await expect(notice(page).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Reopen/ })).toHaveCount(0)
    expect(await chainCount(page)).toBe(1)
    expect((await sessionOf(page)).sessionId).toBe(sessionId)
    await expect
        .poll(async () => (await chainOf(page)).file)
        .toMatchObject({ name: 'coconut.nxsp', event: 'downloaded', confirmed: true })
    expect((await chainOf(page)).chainId).toBe(before.chainId)
    await expect(page.locator('[data-file-chip]')).toHaveCount(0)

    // A Save by name: it downloads again, with no dialog.
    await edit(page, 2)
    expect(await downloaded(page, () => pressSave(page))).toBe('coconut.nxsp')
    await expect(saveDialog(page)).toHaveCount(0)
})

test('the next visit opening the download it saved keeps the session too', async ({ page }) => {
    await start(page, { fileSystemAccess: false })
    const bytes = await savedDownload(page)
    const saved = await chainOf(page)
    await page.evaluate(() => window.nseFlushTest!.flusher.flush({ strict: true }))
    // A new visit: another tab after this one closed continues the chain as a new session.
    const context = page.context()
    await page.close()
    const next = await context.newPage()
    await start(next, { fileSystemAccess: false })
    await expect.poll(async () => (await sessionOf(next)).file?.name).toBe('coconut.nxsp')
    await openBytes(next, bytes, 'coconut.nxsp')
    await expect(notice(next).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    await expect(next.getByRole('button', { name: /^Reopen/ })).toHaveCount(0)
    expect(await chainCount(next)).toBe(1)
    expect((await chainById(next, saved.chainId))?.file).toMatchObject({ event: 'downloaded' })
})

test('opening the download with work since the Save makes a new chain, and the work stays to Reopen', async ({
    page,
}) => {
    await start(page, { fileSystemAccess: false })
    const bytes = await savedDownload(page)
    const saved = await chainOf(page)
    await edit(page, 3)
    await openBytes(page, bytes, 'coconut.nxsp')
    await expect(notice(page).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Reopen/ })).toBeVisible()
    expect(await chainCount(page)).toBe(2)
    expect((await chainOf(page)).chainId).not.toBe(saved.chainId)
    // The edit after the Save is in the chain left.
    const { entries } = await rows(page, ['entries'])
    const left = entries!
        .map((row) => row.value)
        .filter((row) => row.sessionId === saved.head && row.kind === 'edit')
    expect(left).toHaveLength(2)

    // The new chain's first Save asks, and suggests the file's own name: a download takes
    // nothing over, so no " (2)" for the name the other chain is bound to.
    await edit(page, 4)
    await pressSave(page)
    await expect(saveDialog(page).getByRole('textbox')).toHaveValue('coconut')
})
