import { expect, test, type Page } from '@playwright/test'
import { waitForStartup } from './editorFixture'
import {
    chainOf,
    edit,
    notice,
    pressSave,
    rows,
    saveDialog,
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
