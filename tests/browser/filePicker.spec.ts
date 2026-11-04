import { expect, test, type Download, type Page } from '@playwright/test'
import { readFile as readFileBytes } from 'node:fs/promises'
import { readNxsp } from '../../src/local/nxsp'
import { waitForStartup } from './editorFixture'
import {
    chainOf,
    edit,
    flushed,
    notice,
    pauseAt,
    pickerCalls,
    pickMarkerOf,
    pressSave,
    projectOf,
    reached,
    release,
    saveDialog,
    sessionOf,
    start,
    submitSave,
    writeFile,
} from './saveFlows'

// Write to Chosen Files: which browsers Auto gives the save picker, and the Settings row. The
// client hints are stubbed before the page loads, over the OPFS pickers of the override.

type Hints = { platform: string; brand: string; version: string }

const withHints = (page: Page, hints: Hints) =>
    page.addInitScript((hints: Hints) => {
        Object.defineProperty(Navigator.prototype, 'userAgentData', {
            configurable: true,
            get: () => ({
                platform: hints.platform,
                mobile: hints.platform === 'Android',
                brands: [
                    { brand: hints.brand, version: hints.version },
                    { brand: 'Chromium', version: hints.version },
                ],
            }),
        })
    }, hints)

/** The download a Save made, read as a project file. */
const downloadedProject = async (download: Download) => {
    const read = await readNxsp(new Blob([await readFileBytes(await download.path())]))
    if (read.kind !== 'nxsp') throw new Error(`The download is ${read.kind}`)
    return read
}

const saveOnce = async (page: Page) => {
    await edit(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
}

// The rule itself is unit-tested (tests/platform); this shows a real page reads the client hints:
// without them, the desktop rule would give the picker.
test('Auto: Google Chrome 150 on Android downloads', async ({ page }) => {
    await withHints(page, { platform: 'Android', brand: 'Google Chrome', version: '150' })
    await start(page)
    const downloads: Download[] = []
    page.on('download', (download) => downloads.push(download))
    await saveOnce(page)
    await expect(notice(page).filter({ hasText: 'Download started: coconut.nxsp' })).toBeVisible()
    await expect.poll(() => downloads.length).toBe(1)
    expect((await downloadedProject(downloads[0]!)).history).toBeDefined()
    expect(await pickerCalls(page)).toEqual([])
})

test('Disabled downloads on desktop, and the picker returns with Auto', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('sonolus-next-sekai-editor.filePicker', '"disabled"')
    })
    await start(page)
    const downloads: Download[] = []
    page.on('download', (download) => downloads.push(download))
    await saveOnce(page)
    await expect.poll(() => downloads.length).toBe(1)
    expect((await downloadedProject(downloads[0]!)).history).toBeDefined()
    expect(await pickerCalls(page)).toEqual([])
    await page.evaluate(async () => {
        const { settings } =
            (await import('/src/settings.ts')) as typeof import('../../src/settings')
        settings.filePicker = 'auto'
    })
    await page.evaluate(async () => {
        const { saveAs } =
            (await import('/src/editor/save/flow.ts')) as typeof import('../../src/editor/save/flow')
        void saveAs()
    })
    await submitSave(page, 'kiwi', 'Save As')
    await expect(notice(page).filter({ hasText: 'Saved to kiwi.nxsp' })).toBeVisible()
    expect((await projectOf(page, 'kiwi.nxsp')).format).toBe('nxsp')
})

test('under Disabled, a file saved through the picker shows no download until a Save downloads it', async ({
    page,
}) => {
    await start(page)
    const downloads: Download[] = []
    page.on('download', (download) => downloads.push(download))
    await saveOnce(page)
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    await page.evaluate(async () => {
        const { settings } =
            (await import('/src/settings.ts')) as typeof import('../../src/settings')
        settings.filePicker = 'disabled'
    })
    await expect(page.locator('[data-status-file]')).toHaveText('coconut.nxsp')
    await expect(page.locator('[data-status-state]')).toHaveCount(0)
    // Unchanged: No Changes says it was saved, and offers Download Again.
    await pressSave(page)
    await expect(
        notice(page).filter({ hasText: 'No changes since coconut.nxsp was saved' }),
    ).toBeVisible()
    await edit(page, 2)
    await pressSave(page)
    await expect.poll(() => downloads.length).toBe(1)
    expect((await downloadedProject(downloads[0]!)).history).toBeDefined()
    await expect(page.locator('[data-status-state]')).toContainText('downloaded')
})

/** A save picker that never returns, as when the browser is closed while it is open. */
const hangingPicker = (page: Page) =>
    page.addInitScript(() => {
        if (sessionStorage.getItem('picked')) return
        Object.defineProperty(window, 'showSaveFilePicker', {
            configurable: true,
            value: () => {
                sessionStorage.setItem('picked', 'yes')
                return new Promise(() => undefined)
            },
        })
    })

/** Another chain's marker, as a tab closed during its pick leaves it. */
const otherMarker = (page: Page) =>
    page.evaluate(
        () =>
            new Promise<void>((resolve) => {
                const request = indexedDB.open('nse-pick', 1)
                request.onupgradeneeded = () => request.result.createObjectStore('pick')
                request.onsuccess = () => {
                    const transaction = request.result.transaction('pick', 'readwrite')
                    transaction
                        .objectStore('pick')
                        .put({ chainId: 'other', surface: 'save', at: Date.now() }, 'other')
                    transaction.oncomplete = () => {
                        request.result.close()
                        resolve()
                    }
                }
            }),
    )

test('a page closed while its picker is open says at the next start that the save did not finish', async ({
    page,
}) => {
    await hangingPicker(page)
    await start(page, { fileSystemAccess: true })
    await edit(page, 1)
    await flushed(page)
    const chainId = String((await chainOf(page)).chainId)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect
        .poll(() => pickMarkerOf(page, chainId))
        .toEqual(expect.objectContaining({ chainId, surface: 'save' }))
    await page.reload()
    await waitForStartup(page)
    await expect(
        page.getByText('A save did not finish. The file you chose may be empty.', { exact: true }),
    ).toBeVisible()
    await expect.poll(() => pickMarkerOf(page, chainId)).toBeNull()
})

test("Recent Sessions' Save… marks the open session's chain; a finished pick leaves no marker", async ({
    page,
}) => {
    await start(page)
    await edit(page, 1)
    await flushed(page)
    const earlier = await sessionOf(page)
    await page.evaluate(async () => {
        const { resetState } =
            (await import('/src/history/index.ts')) as typeof import('../../src/history')
        resetState(false)
    })
    await edit(page, 2)
    await flushed(page)
    const openChain = String((await chainOf(page)).chainId)
    await pauseAt(page, 'picked')
    await page.evaluate((sessionId) => {
        void import('/src/editor/save/flow.ts').then((flow) => flow.saveToFile(sessionId))
    }, earlier.sessionId)
    await submitSave(page, 'restored')
    await reached(page, 'picked')
    expect(await pickMarkerOf(page, openChain)).toEqual(
        expect.objectContaining({ chainId: openChain }),
    )
    await release(page)
    await expect(notice(page).filter({ hasText: 'Saved to restored.nxsp' })).toBeVisible()
    await expect.poll(() => pickMarkerOf(page, openChain)).toBeNull()
})

test("a pick in this tab leaves another chain's marker", async ({ page }) => {
    await start(page)
    await otherMarker(page)
    await saveOnce(page)
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    expect(await pickMarkerOf(page, 'other')).toEqual(expect.objectContaining({ chainId: 'other' }))
})

const openLocalData = (page: Page) =>
    page.evaluate(async () => {
        const { openSettings } =
            (await import('/src/editor/settings/openSettings.ts')) as typeof import('../../src/editor/settings/openSettings')
        void openSettings('localData')
    })

test('Settings › Local Data offers Write to Chosen Files where the picker exists', async ({
    page,
}) => {
    await start(page)
    await openLocalData(page)
    const field = page.locator('#settings-localData [data-file-picker]')
    const select = field.getByRole('combobox')
    await expect(select).toHaveValue('auto')
    await expect(select.locator('option')).toHaveText(['Auto', 'Enabled', 'Disabled'])
    await select.selectOption('disabled')
    expect(
        await page.evaluate(async () => {
            const { settings } =
                (await import('/src/settings.ts')) as typeof import('../../src/settings')
            return settings.filePicker
        }),
    ).toBe('disabled')
    expect(
        await page.evaluate(async () => {
            const { platform } =
                (await import('/src/platform/index.ts')) as typeof import('../../src/platform')
            return [!!platform.pickSaveFile, platform.capabilities.writeBack]
        }),
    ).toEqual([false, false])
})

test('Settings › Local Data has no Write to Chosen Files without the picker', async ({ page }) => {
    await start(page, { fileSystemAccess: false })
    await openLocalData(page)
    await expect(page.locator('#settings-localData [data-confirm-close]')).toBeVisible()
    await expect(page.locator('[data-file-picker]')).toHaveCount(0)
})

test('Disabled: a first Save of an opened "coconut (3).nxsp" kept with a handle suggests its recorded name', async ({
    page,
    browser,
}) => {
    // The file: a project downloaded as coconut.nxsp, so its revision records that name. It is
    // made in a context of its own, so this page's chain never wrote it.
    const maker = await browser.newContext({ baseURL: test.info().project.use.baseURL })
    const making = await maker.newPage()
    await start(making, { fileSystemAccess: false })
    await edit(making, 1)
    const downloading = making.waitForEvent('download')
    await pressSave(making)
    await submitSave(making, 'coconut')
    const bytes = [...(await readFileBytes((await (await downloading).path())!))]
    await maker.close()

    await page.addInitScript(() => {
        localStorage.setItem('sonolus-next-sekai-editor.filePicker', '"disabled"')
    })
    await start(page)
    await writeFile(page, 'coconut (3).nxsp', bytes)
    await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory()
        const handle = await root.getFileHandle('coconut (3).nxsp')
        const { openProject } = await import('/src/editor/commands/open/project.ts')
        await openProject(await handle.getFile(), handle)
    })
    // The binding keeps the handle's name, for reading the file and recognising it.
    await expect
        .poll(async () => (await chainOf(page)).file)
        .toMatchObject({ name: 'coconut (3).nxsp', event: 'opened', downloadName: 'coconut.nxsp' })
    await edit(page, 2)
    await pressSave(page)
    await expect(saveDialog(page).getByRole('textbox')).toHaveValue('coconut')
})
