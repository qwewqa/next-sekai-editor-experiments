import { expect, test, type Page } from '@playwright/test'
import { executePlan, planNxsp } from '../../src/local/nxsp'
import { fresh } from '../local/nxsp/chain'
import { waitForStartup } from './editorFixture'
import {
    chainOf,
    edit,
    notice,
    pickerCalls,
    pressSave,
    projectOf,
    readFile,
    removeFile,
    rows,
    saveDialog,
    sessionOf,
    start,
    submitSave,
    writeFile,
} from './saveFlows'

// Save and Save As on the Chromium override (Part 1 §1.4.7, §1.11.6's exit items): the first
// Save binds through the project picker, a second writes in place, revisions chain.

test('Save binds, the status shows the file name, and a second Save writes in place', async ({
    page,
}) => {
    await start(page)
    await edit(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()

    const calls = await pickerCalls(page)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
        picker: 'save',
        id: 'nse-project',
        suggestedName: 'coconut.nxsp',
        excludeAcceptAllOption: true,
        startIn: 'documents',
        types: [
            {
                description: 'Next SEKAI project file',
                accept: { 'application/octet-stream': ['.nxsp'] },
            },
        ],
    })
    await expect
        .poll(async () => (await chainOf(page)).file)
        .toMatchObject({
            name: 'coconut.nxsp',
            event: 'saved',
        })
    expect((await sessionOf(page)).file?.name).toBe('coconut.nxsp')
    const first = await projectOf(page, 'coconut.nxsp')
    const firstRevision = first.revision as Record<string, unknown>

    await edit(page, 2)
    await pressSave(page)
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    await expect
        .poll(async () => (await projectOf(page, 'coconut.nxsp')).revision)
        .toMatchObject({
            parent: firstRevision.id,
            ancestors: [firstRevision.id],
            n: 2,
        })
    expect(await pickerCalls(page)).toHaveLength(1)

    // Each Save's `save` entry, with its revision and device.
    const { entries } = await rows(page, ['entries'])
    const saves = entries!.map((row) => row.value).filter((row) => row.kind === 'save')
    expect(saves).toHaveLength(2)
    expect(saves[0]).toMatchObject({
        revisionId: firstRevision.id,
        device: { label: 'Web (Chrome)' },
    })
})

/** A first Save to coconut.nxsp, settled. */
const savedOnce = async (page: Page) => {
    await edit(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    await expect.poll(async () => (await chainOf(page)).file).toMatchObject({ event: 'saved' })
}

const choice = (page: Page) => page.getByRole('dialog')

test('the file rewritten with the same size and time gives the conflict dialog', async ({
    page,
}) => {
    await start(page)
    await savedOnce(page)
    const bytes = (await readFile(page, 'coconut.nxsp'))!
    const before = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory()
        const file = await (await root.getFileHandle('coconut.nxsp')).getFile()
        return { size: file.size, lastModified: file.lastModified }
    })
    // The same length, another central directory: an entry's "version made by" byte changed.
    const changed = [...bytes]
    let at = -1
    for (let i = 0; i + 4 < changed.length; i++)
        if (
            changed[i] === 0x50 &&
            changed[i + 1] === 0x4b &&
            changed[i + 2] === 1 &&
            changed[i + 3] === 2
        ) {
            at = i + 4
            break
        }
    expect(at).toBeGreaterThan(0)
    changed[at] = changed[at]! ^ 1
    await writeFile(page, 'coconut.nxsp', changed)
    expect(changed).toHaveLength(before.size)

    await edit(page, 2)
    await pressSave(page)
    const dialog = choice(page)
    await expect(dialog).toContainText('"coconut.nxsp" Changed')
    await expect(dialog.getByRole('button', { name: 'Save as a Separate File' })).toBeFocused()
    // Nothing was written over it.
    expect(await readFile(page, 'coconut.nxsp')).toEqual(changed)
})

test('an unchanged session with a changed file still gets the dialog on p', async ({ page }) => {
    await start(page)
    await savedOnce(page)
    const other = [
        ...new Uint8Array(
            await (await executePlan(planNxsp(fresh().input).plan, new Map())).arrayBuffer(),
        ),
    ]
    await writeFile(page, 'coconut.nxsp', other)
    await pressSave(page)
    await expect(choice(page)).toContainText('"coconut.nxsp" Changed')
})

test('a touched file (the same bytes, a new time) is appended to with no dialog', async ({
    page,
}) => {
    await start(page)
    await savedOnce(page)
    const bytes = (await readFile(page, 'coconut.nxsp'))!
    const disk = (await chainOf(page)).file as { disk: { lastModified: number } }
    await page.waitForTimeout(20)
    await writeFile(page, 'coconut.nxsp', bytes)
    await edit(page, 2)
    await pressSave(page)
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    await expect
        .poll(async () => ((await chainOf(page)).file as typeof disk).disk.lastModified)
        .not.toBe(disk.disk.lastModified)
    expect(await choice(page).count()).toBe(0)
})

test('no changes since the Save: the check runs, and nothing is written', async ({ page }) => {
    await start(page)
    await savedOnce(page)
    const bytes = await readFile(page, 'coconut.nxsp')
    await pressSave(page)
    await expect(
        notice(page).filter({ hasText: 'No changes since coconut.nxsp was saved' }),
    ).toBeVisible()
    expect(await readFile(page, 'coconut.nxsp')).toEqual(bytes)
})

test('the file deleted gives the not-found dialog; Save As… keeps the docId and suggests (2)', async ({
    page,
}) => {
    await start(page)
    await savedOnce(page)
    const docId = (await chainOf(page)).docId
    await removeFile(page, 'coconut.nxsp')
    await edit(page, 2)
    await pressSave(page)
    const dialog = choice(page)
    await expect(dialog).toContainText('"coconut.nxsp" cannot be found.')
    await page.waitForTimeout(350)
    await dialog.getByRole('button', { name: 'Save As…' }).click()
    const saveAs = saveDialog(page, 'Save As')
    await expect(saveAs.getByRole('textbox')).toHaveValue('coconut (2)')
    await submitSave(page, undefined, 'Save As')
    await expect(notice(page).filter({ hasText: 'Saved to coconut (2).nxsp' })).toBeVisible()
    const project = await projectOf(page, 'coconut (2).nxsp')
    expect(project.id).toBe(docId)
    expect((await chainOf(page)).docId).toBe(docId)
})

test('Save As gives a new docId and a revision with no parent', async ({ page }) => {
    await start(page)
    await savedOnce(page)
    const first = await projectOf(page, 'coconut.nxsp')
    await page.evaluate(async () => {
        const { commands } = await import('/src/editor/commands/index.ts')
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        void runCommand(commands.saveAs)
    })
    const dialog = saveDialog(page, 'Save As')
    await expect(dialog.getByRole('textbox')).toHaveValue('coconut (2)')
    await submitSave(page, 'melt', 'Save As')
    await expect(notice(page).filter({ hasText: 'Saved to melt.nxsp' })).toBeVisible()
    const second = await projectOf(page, 'melt.nxsp')
    expect(second.id).not.toBe(first.id)
    expect((second.revision as Record<string, unknown>).parent).toBeNull()
    await expect.poll(async () => (await chainOf(page)).docId).toBe(second.id)
    // The old file is untouched.
    expect((await projectOf(page, 'coconut.nxsp')).revision).toEqual(first.revision)
})

test('Ctrl+S is Save: the keydown’s default is prevented and Save runs', async ({ page }) => {
    await start(page)
    await edit(page, 1)
    await page.evaluate(() => {
        addEventListener('keydown', (event) => {
            if (event.key === 's')
                setTimeout(() => {
                    ;(window as { prevented?: boolean }).prevented = event.defaultPrevented
                })
        })
    })
    await page
        .locator('canvas.editor-chart')
        .focus()
        .catch(() => undefined)
    await page.keyboard.press('Control+s')
    await expect(saveDialog(page)).toBeVisible()
    expect(await page.evaluate(() => (window as { prevented?: boolean }).prevented)).toBe(true)
})

test('a reload after close() and before the binding: the next Save records it and appends', async ({
    page,
}) => {
    await start(page)
    await savedOnce(page)
    await edit(page, 2)
    await page.evaluate(() => localStorage.setItem('nse.test.savePause', 'closed'))
    await pressSave(page)
    await expect
        .poll(() => page.evaluate(() => window.nseSaveTest?.reached ?? []))
        .toContain('closed')
    const written = await projectOf(page, 'coconut.nxsp')
    await page.evaluate(() => localStorage.removeItem('nse.test.savePause'))
    await page.reload()
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await waitForStartup(page)

    await edit(page, 3)
    await pressSave(page)
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    expect(await choice(page).count()).toBe(0)
    const revision = (await projectOf(page, 'coconut.nxsp')).revision as Record<string, unknown>
    const writtenId = (written.revision as Record<string, unknown>).id
    expect(revision.parent).toBe(writtenId)
    const { entries } = await rows(page, ['entries'])
    const saves = entries!.map((row) => row.value).filter((row) => row.kind === 'save')
    expect(saves.map((row) => row.revisionId)).toContain(writtenId)
    expect(saves).toHaveLength(3)
})
