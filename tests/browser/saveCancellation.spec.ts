import { expect, test, type Page } from '@playwright/test'
import {
    builds,
    edit,
    notice,
    preparingDialog,
    pressSave,
    readFile,
    saveReserved,
    start,
    submitSave,
} from './saveFlows'

// Save's picker and write paths with the browser's own picker stubbed (Part 1 §1.4.7; Step 6
// migrated this spec from level data to `.nxsp`): a dismissed picker writes and downloads nothing,
// a picker failure is an error and never a download (R12), a failed write leaves the file as it
// was and binds nothing, and a browser without a save picker downloads. The stub's handles aren't
// stored (a suspected private window), as a real browser's would be.

type SaveMode = 'abortPicker' | 'pickerFailure' | 'success' | 'missingAPI' | 'writeFailure'

declare global {
    interface Window {
        saveReview: {
            events: string[]
            downloads: { name: string; size: number }[]
            committed?: Blob
        }
    }
}

const errors = new WeakMap<Page, string[]>()

const installSave = async (page: Page, mode: SaveMode) => {
    await page.addInitScript((mode) => {
        window.saveReview = { events: [], downloads: [] }
        const fixture = window.saveReview
        // Record downloads without touching disk.
        HTMLAnchorElement.prototype.click = function () {
            const name = this.download
            void fetch(this.href)
                .then((response) => response.blob())
                .then((blob) => fixture.downloads.push({ name, size: blob.size }))
        }
        let pending: Blob | undefined
        const writable = {
            write(blob: Blob) {
                pending = blob
                fixture.events.push('write')
                if (mode === 'writeFailure')
                    return Promise.reject(new DOMException('Disk full', 'QuotaExceededError'))
                return Promise.resolve()
            },
            close() {
                fixture.events.push('close')
                fixture.committed = pending
                return Promise.resolve()
            },
            abort() {
                fixture.events.push('abort')
                return Promise.resolve()
            },
        }
        const handle = {
            kind: 'file',
            name: 'coconut.nxsp',
            getFile: () =>
                Promise.resolve(
                    new File([fixture.committed ?? new Blob([])], 'coconut.nxsp', {
                        lastModified: 1000,
                    }),
                ),
            isSameEntry: (other: unknown) => Promise.resolve(other === handle),
            createWritable() {
                fixture.events.push('create')
                return Promise.resolve(writable)
            },
        }
        Object.defineProperty(window, 'showSaveFilePicker', {
            configurable: true,
            value:
                mode === 'missingAPI'
                    ? undefined
                    : () => {
                          fixture.events.push('picker')
                          if (mode === 'abortPicker')
                              return Promise.reject(
                                  new DOMException('Picker dismissed', 'AbortError'),
                              )
                          if (mode === 'pickerFailure')
                              return Promise.reject(
                                  new DOMException(
                                      'Must be handling a user gesture',
                                      'SecurityError',
                                  ),
                              )
                          return Promise.resolve(handle)
                      },
        })
    }, mode)
    await start(page, { fileSystemAccess: true, override: { privateSuspected: true } })
}

test.beforeEach(({ page }) => {
    const collected: string[] = []
    errors.set(page, collected)
    page.on('pageerror', (error) => collected.push(error.message))
})

test.afterEach(({ page }) => {
    expect(errors.get(page)).toEqual([])
})

const firstSave = async (page: Page) => {
    await edit(page, 1)
    await page.keyboard.press('p')
    await submitSave(page, 'coconut')
}

const bound = (page: Page) =>
    page.evaluate(async () => {
        const { session } = await import('/src/history/session.ts')
        return session.value.file?.name
    })

test('dismissing the save picker writes nothing, downloads nothing and binds nothing', async ({
    page,
}) => {
    await installSave(page, 'abortPicker')
    await firstSave(page)
    await expect.poll(() => page.evaluate(() => window.saveReview.events)).toContain('picker')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await page.evaluate(() => window.saveReview.downloads)).toEqual([])
    expect(await page.evaluate(() => window.saveReview.events)).toEqual(['picker'])
    expect(await bound(page)).toBeUndefined()
})

test('a picker failure is shown as an error, never a download (R12)', async ({ page }) => {
    await installSave(page, 'pickerFailure')
    await firstSave(page)
    await expect(page.getByRole('dialog')).toContainText(
        'The browser did not allow writing to coconut.nxsp.',
    )
    expect(await page.evaluate(() => window.saveReview.downloads)).toEqual([])
    expect(await bound(page)).toBeUndefined()
})

test('a successful Save writes once and binds the picked file', async ({ page }) => {
    await installSave(page, 'success')
    await firstSave(page)
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    expect(await page.evaluate(() => window.saveReview.events)).toEqual([
        'picker',
        'create',
        'write',
        'close',
    ])
    expect(await page.evaluate(() => window.saveReview.downloads)).toEqual([])
    expect(await bound(page)).toBe('coconut.nxsp')
})

test('a write that fails before close() aborts, stays bound to the emptied file and offers Save As…', async ({
    page,
}) => {
    await installSave(page, 'writeFailure')
    await firstSave(page)
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('There is not enough space to write coconut.nxsp.')
    await expect(dialog.getByRole('button', { name: 'Save As…' })).toBeVisible()
    expect(await page.evaluate(() => window.saveReview.events)).toEqual([
        'picker',
        'create',
        'write',
        'abort',
    ])
    expect(await page.evaluate(() => window.saveReview.downloads)).toEqual([])
    // The pick emptied the file, so the session is pre-bound to it: the next Save fills it (R9).
    expect(await bound(page)).toBe('coconut.nxsp')
})

test('a browser without a save picker downloads, bound by name', async ({ page }) => {
    await installSave(page, 'missingAPI')
    await firstSave(page)
    await expect.poll(() => page.evaluate(() => window.saveReview.downloads.length)).toBe(1)
    const [download] = await page.evaluate(() => window.saveReview.downloads)
    expect(download!.name).toBe('coconut.nxsp')
    expect(download!.size).toBeGreaterThan(0)
    expect(await page.evaluate(() => window.saveReview.events)).toEqual([])
    await expect(notice(page).filter({ hasText: 'Download started: coconut.nxsp' })).toBeVisible()
    expect(await bound(page)).toBe('coconut.nxsp')
})

test('Cancel in a slow write-back’s Preparing… writes nothing, and the next Save writes (SF-5)', async ({
    page,
}) => {
    await start(page)
    await edit(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    const before = await readFile(page, 'coconut.nxsp')
    await edit(page, 2)
    await builds(page, 2500)
    await pressSave(page)
    await preparingDialog(page).getByRole('button', { name: 'Cancel' }).click()
    await expect(preparingDialog(page)).toHaveCount(0)
    await page.waitForTimeout(2500)
    expect(await readFile(page, 'coconut.nxsp')).toEqual(before)
    await expect.poll(() => saveReserved(page)).toBe(false)
    await builds(page, undefined)
    await pressSave(page)
    await expect.poll(() => readFile(page, 'coconut.nxsp')).not.toEqual(before)
})
