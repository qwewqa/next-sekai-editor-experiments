import { expect, test, type Download, type Page } from '@playwright/test'
import { readFile as readFileBytes } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { executePlan, planNxsp, readNxsp } from '../../src/local/nxsp'
import { fresh } from '../local/nxsp/chain'
import { installEditorFixture } from './editorFixture'
import {
    openVideoDialog,
    shortVideoClip,
    videoExportButton,
    videoExportTimeout,
    videoPhase,
} from './exportVideoDialog'
import { resource } from './previewResourceFixture'
import {
    chainOf,
    edit,
    flushed,
    notice,
    pauseAt,
    pickerCalls,
    pressSave,
    queuePicks,
    reached,
    readFile,
    release,
    sessionOf,
    start,
    submitSave,
    writeFile,
} from './saveFlows'

// Always Download after a failed write to a chosen file: Write to Chosen Files becomes Disabled,
// and the same action runs again as a download. While `window.failWrites` names an error,
// `createWritable()` fails on the prototype with it, as Chrome for Android's does for a long name
// in a folder (a FileError at step `create`); the handles stay plain, as handles with properties of
// their own cannot be stored.

/** A project another program wrote, as the conflict specs make it. */
const otherProject = [
    ...new Uint8Array(
        await (await executePlan(planNxsp(fresh().input).plan, new Map())).arrayBuffer(),
    ),
]

const failingWrites = (page: Page) =>
    page.addInitScript(() => {
        const create = FileSystemFileHandle.prototype.createWritable
        FileSystemFileHandle.prototype.createWritable = function (
            this: FileSystemFileHandle,
            options?: FileSystemCreateWritableOptions,
        ) {
            const name = Reflect.get(window, 'failWrites') as string | undefined
            return name
                ? Promise.reject(new DOMException('Error creating swap file.', name))
                : create.call(this, options)
        }
    })

const failWrites = (page: Page, name: string | undefined) =>
    page.evaluate((name) => Reflect.set(window, 'failWrites', name), name)

/**
 * Runs `act`, and fails the write once the picker has returned its file: the test pickers make and
 * empty the file through `createWritable()` too, and a device's picker succeeds.
 */
const failAfterPick = async (page: Page, name: string, act: () => Promise<void>) => {
    await pauseAt(page, 'picked')
    await act()
    await reached(page, 'picked')
    await failWrites(page, name)
    await release(page)
}

const setting = (page: Page) =>
    page.evaluate(async () => {
        const { settings } =
            (await import('/src/settings.ts')) as typeof import('../../src/settings')
        return settings.filePicker
    })

/** Presses a choice once the dialog's guard against an accidental press has passed. */
const choose = async (page: Page, name: string) => {
    const button = page.getByRole('dialog').getByRole('button', { name, exact: true })
    await expect(button).toBeVisible()
    await page.waitForTimeout(350)
    await button.click()
}

const downloadedProject = async (download: Download) => {
    const read = await readNxsp(new Blob([await readFileBytes(await download.path())]))
    if (read.kind !== 'nxsp' || !read.history) throw new Error(`The download is ${read.kind}`)
    return read
}

/** The BPM values of a download's level data. */
const bpms = (read: Awaited<ReturnType<typeof downloadedProject>>) =>
    (read.level as { entities: { data: { name: string; value?: number }[] }[] }).entities.flatMap(
        (entity) => entity.data.filter(({ name }) => name === '#BPM').map(({ value }) => value),
    )

const lastSave = (read: Awaited<ReturnType<typeof downloadedProject>>) =>
    JSON.stringify(read.history!.entries.filter((entry) => entry.kind === 'save').at(-1)?.operation)

test('Save: a write that fails offers Always Download, which downloads the save and binds it by name', async ({
    page,
}) => {
    await failingWrites(page)
    await start(page)
    const downloads: Download[] = []
    page.on('download', (download) => downloads.push(download))
    await edit(page, 1)
    await failAfterPick(page, 'InvalidStateError', async () => {
        await pressSave(page)
        await submitSave(page, 'coconut')
    })
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('“coconut.nxsp” could not be written.')
    await expect(dialog).toContainText('The file is now empty.')
    await expect(dialog.locator('[data-choice-buttons] button')).toHaveText([
        'Cancel',
        'Always Download',
        'Save As…',
    ])
    await expect(dialog.getByRole('button', { name: 'Save As…' })).toBeFocused()
    await choose(page, 'Always Download')
    await expect(notice(page).filter({ hasText: 'Download started: coconut.nxsp' })).toBeVisible()
    await expect.poll(() => downloads.length).toBe(1)
    expect(downloads[0]!.suggestedFilename()).toBe('coconut.nxsp')
    expect(lastSave(await downloadedProject(downloads[0]!))).toContain('"delivery":"download"')
    expect(await readFile(page, 'coconut.nxsp')).toEqual([])
    expect(await setting(page)).toBe('disabled')
    // One picker: the download asked for none.
    expect(await pickerCalls(page)).toHaveLength(1)
    await flushed(page)
    expect((await chainOf(page)).file).toMatchObject({ name: 'coconut.nxsp', event: 'downloaded' })
})

test('Save: a refused write offers Always Download beside Save As… and Try Again', async ({
    page,
}) => {
    await failingWrites(page)
    await start(page)
    await edit(page, 1)
    await failAfterPick(page, 'NotAllowedError', async () => {
        await pressSave(page)
        await submitSave(page, 'coconut')
    })
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('The browser did not allow writing to coconut.nxsp.')
    await expect(dialog.locator('[data-choice-buttons] button')).toHaveText([
        'Cancel',
        'Always Download',
        'Save As…',
        'Try Again',
    ])
    await expect(dialog.getByRole('button', { name: 'Try Again' })).toBeFocused()
})

test("Recent Sessions' Save…: Always Download downloads the stored session and binds nothing", async ({
    page,
}) => {
    await failingWrites(page)
    await start(page)
    const downloads: Download[] = []
    page.on('download', (download) => downloads.push(download))
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
    const open = await chainOf(page)
    await failAfterPick(page, 'InvalidStateError', async () => {
        await page.evaluate((sessionId) => {
            void import('/src/editor/save/flow.ts').then((flow) => flow.saveToFile(sessionId))
        }, earlier.sessionId)
        await submitSave(page, 'restored')
    })
    await expect(page.getByRole('dialog')).toContainText('could not be written.')
    await choose(page, 'Always Download')
    await expect(notice(page).filter({ hasText: 'Download started: restored.nxsp' })).toBeVisible()
    await expect.poll(() => downloads.length).toBe(1)
    // The selected session's BPM change (101 at beat 1), not the open session's (102 at beat 2).
    const tempos = bpms(await downloadedProject(downloads[0]!))
    expect(tempos).toContain(101)
    expect(tempos).not.toContain(102)
    expect(await setting(page)).toBe('disabled')
    await flushed(page)
    expect((await chainOf(page)).file).toEqual(open.file)
})

test('Save: a write-back that fails offers Always Download, which downloads the changed work', async ({
    page,
}) => {
    await failingWrites(page)
    await start(page)
    const downloads: Download[] = []
    page.on('download', (download) => downloads.push(download))
    await edit(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    const saved = await readFile(page, 'coconut.nxsp')
    await edit(page, 2)
    await failWrites(page, 'InvalidStateError')
    await pressSave(page)
    await expect(page.getByRole('dialog')).toContainText('“coconut.nxsp” could not be written.')
    // A write-back writes beside the file: it is not emptied.
    await expect(page.getByRole('dialog')).not.toContainText('The file is now empty.')
    await choose(page, 'Always Download')
    await expect.poll(() => downloads.length).toBe(1)
    expect(lastSave(await downloadedProject(downloads[0]!))).toContain('"delivery":"download"')
    expect(await readFile(page, 'coconut.nxsp')).toEqual(saved)
    await flushed(page)
    expect((await chainOf(page)).file).toMatchObject({ name: 'coconut.nxsp', event: 'downloaded' })
})

test('Replace: a write that fails after the disk version is kept offers Always Download; the conflict dialog does not', async ({
    page,
}) => {
    await failingWrites(page)
    await start(page)
    const downloads: Download[] = []
    page.on('download', (download) => downloads.push(download))
    await edit(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    // Another program writes another project to the file.
    await writeFile(page, 'coconut.nxsp', otherProject)
    const other = await readFile(page, 'coconut.nxsp')
    await edit(page, 2)
    await pressSave(page)
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('“coconut.nxsp” Changed')
    await expect(dialog.getByRole('button', { name: 'Always Download' })).toHaveCount(0)
    await failWrites(page, 'InvalidStateError')
    await choose(page, 'Replace')
    await expect(dialog).toContainText('“coconut.nxsp” could not be written.')
    await choose(page, 'Always Download')
    await expect.poll(() => downloads.length).toBe(1)
    expect(lastSave(await downloadedProject(downloads[0]!))).toContain('"delivery":"download"')
    // The file on disk is as the other program left it.
    expect(await readFile(page, 'coconut.nxsp')).toEqual(other)
    expect(await setting(page)).toBe('disabled')
})

test('Export Level Data: Always Download after a failed write downloads the level data', async ({
    page,
}) => {
    await failingWrites(page)
    await start(page)
    const downloads: Download[] = []
    page.on('download', (download) => downloads.push(download))
    await queuePicks(page, ['coconut.nsld'])
    const exportDialog = page.getByRole('dialog')
    await failAfterPick(page, 'InvalidStateError', async () => {
        await page.locator('canvas.editor-chart').focus()
        await page.keyboard.press('Shift+P')
        await exportDialog.locator('button[type="submit"]').click()
    })
    await expect(exportDialog).toContainText('“coconut.nsld” could not be written.')
    await expect(exportDialog.locator('[data-choice-buttons] button')).toHaveText([
        'Cancel',
        'Always Download',
        'Choose Another…',
    ])
    await choose(page, 'Always Download')
    await expect.poll(() => downloads.length).toBe(1)
    const json = JSON.parse(
        gunzipSync(await readFileBytes(await downloads[0]!.path())).toString(),
    ) as { entities: unknown[] }
    expect(Array.isArray(json.entities)).toBe(true)
    expect(await setting(page)).toBe('disabled')
})

/** The Export Video dialog on the page's own route, over a chart with notes. */
const openVideo = async (page: Page) => {
    await page.route('**/resource/skin.scp*', (route) => route.fulfill({ body: resource('skins') }))
    await page.route('**/resource/particle.scp*', (route) =>
        route.fulfill({ body: resource('particles') }),
    )
    await page.goto('/')
    await page.evaluate(installEditorFixture)
    await page.evaluate(() => window.editorTest.show(window.editorTest.fixtures.notes))
    return openVideoDialog(page, { production: true })
}

const videoPage = async (page: Page, pickerError: string) => {
    await page.addInitScript((name) => {
        Object.defineProperty(window, 'showSaveFilePicker', {
            configurable: true,
            value: () => Promise.reject(new DOMException('Refused', name)),
        })
    }, pickerError)
    const dialog = await openVideo(page)
    await shortVideoClip(page)
    await dialog.locator('[data-export-advanced]').click()
    await dialog.getByRole('combobox', { name: 'Format', exact: true }).selectOption('webm')
    await expect(videoExportButton(page)).toBeEnabled({ timeout: videoExportTimeout })
    await videoExportButton(page).click()
    await expect.poll(() => videoPhase(page), { timeout: videoExportTimeout }).toBe('failed')
    return dialog
}

test('Export Video: Always Download after a refused picker exports again and downloads from Ready', async ({
    page,
}, testInfo) => {
    test.slow()
    const dialog = await videoPage(page, 'NotAllowedError')
    await expect(dialog).toContainText('The browser did not allow writing to')
    await dialog.locator('[data-export-always-download]').click()
    await expect.poll(() => videoPhase(page), { timeout: videoExportTimeout }).toBe('ready')
    const downloading = page.waitForEvent('download')
    await dialog.locator('[data-export-download]').click()
    const download = await downloading
    const path = testInfo.outputPath('export.webm')
    await download.saveAs(path)
    const frames = await page.evaluate(
        async (bytes) => {
            const { readVideo } = await import('/tests/helpers/readVideo.ts')
            return (await readVideo(bytes)).frames
        },
        [...(await readFileBytes(path))],
    )
    expect(frames).toBe(6)
    expect(await setting(page)).toBe('disabled')
})

test('Export Video: a full disk at the picker does not offer Always Download', async ({ page }) => {
    test.slow()
    const dialog = await videoPage(page, 'QuotaExceededError')
    await expect(dialog.locator('[data-export-close]')).toBeVisible()
    await expect(dialog.locator('[data-export-always-download]')).toHaveCount(0)
})

test('Export Video: the picker turned off in the open dialog brings the storage warning', async ({
    page,
}) => {
    // Browser storage past the line where cleanup starts.
    await page.addInitScript(() => {
        Object.defineProperty(StorageManager.prototype, 'estimate', {
            configurable: true,
            value: () => Promise.resolve({ usage: 99e9, quota: 100e9 }),
        })
    })
    const dialog = await openVideo(page)
    const warning = dialog.getByText('Browser storage is almost full.')
    // A picked file is not in browser storage.
    await expect(dialog.getByRole('combobox', { name: 'Resolution' })).toBeVisible()
    await expect(warning).toHaveCount(0)
    // As Always Download does, with the dialog open: the export then goes to a staged file.
    await page.evaluate(async () => {
        const { settings } =
            (await import('/src/settings.ts')) as typeof import('../../src/settings')
        settings.filePicker = 'disabled'
    })
    await expect(warning).toBeVisible()
})
