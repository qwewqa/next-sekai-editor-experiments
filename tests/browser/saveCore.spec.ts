import { expect, test, type Page } from '@playwright/test'
import { executePlan, planNxsp } from '../../src/local/nxsp'
import { fresh } from '../local/nxsp/chain'
import { waitForStartup } from './editorFixture'
import {
    chainOf,
    edit,
    flushed,
    notice,
    pickerCalls,
    pressSave,
    projectOf,
    queuePicks,
    readFile,
    removeFile,
    rows,
    saveDialog,
    sessionOf,
    start,
    submitSave,
    writeFile,
} from './saveFlows'

// Save and Save As on the Chromium override: the first
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
    await expect(dialog).toContainText('“coconut.nxsp” Changed')
    await expect(dialog.getByRole('button', { name: 'Save as a Separate File…' })).toBeFocused()
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
    await expect(choice(page)).toContainText('“coconut.nxsp” Changed')
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
    // An Export target, which Save As… from here keeps.
    await queuePicks(page, ['LevelData'])
    await page.keyboard.press('Shift+P')
    await expect(page.getByRole('dialog').filter({ hasText: 'Export Level Data' })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(notice(page).filter({ hasText: 'Exported to LevelData' })).toBeVisible()
    await flushed(page)
    const docId = (await chainOf(page)).docId
    await removeFile(page, 'coconut.nxsp')
    await edit(page, 2)
    await pressSave(page)
    const dialog = choice(page)
    await expect(dialog).toContainText('“coconut.nxsp” could not be found.')
    // No hint to pick the moved file: a save picker would empty it.
    await expect(dialog).not.toContainText('moved')
    await page.waitForTimeout(350)
    await dialog.getByRole('button', { name: 'Save As…' }).click()
    const saveAs = saveDialog(page, 'Save As')
    await expect(saveAs.getByRole('textbox')).toHaveValue('coconut (2)')
    await submitSave(page, undefined, 'Save As')
    await expect(notice(page).filter({ hasText: 'Saved to coconut (2).nxsp' })).toBeVisible()
    const project = await projectOf(page, 'coconut (2).nxsp')
    expect(project.id).toBe(docId)
    expect((await chainOf(page)).docId).toBe(docId)
    await flushed(page)
    expect((await chainOf(page)).exportTarget).toMatchObject({ name: 'LevelData' })
})

test('the Export link in the not-found dialog’s Save As… opens Export Level Data', async ({
    page,
}) => {
    await start(page)
    await savedOnce(page)
    await removeFile(page, 'coconut.nxsp')
    await edit(page, 2)
    await pressSave(page)
    const dialog = choice(page)
    await expect(dialog).toContainText('“coconut.nxsp” could not be found.')
    await page.waitForTimeout(350)
    await dialog.getByRole('button', { name: 'Save As…' }).click()
    const saveAs = saveDialog(page, 'Save As')
    await saveAs.getByRole('button', { name: 'Export Level Data…' }).click()
    await expect(saveAs).toHaveCount(0)
    await expect(page.getByRole('dialog').filter({ hasText: 'Export Level Data' })).toBeVisible()
})

test('Save As gives a new docId and a revision with no parent', async ({ page }) => {
    await start(page)
    await savedOnce(page)
    const first = await projectOf(page, 'coconut.nxsp')
    await page.evaluate(async () => {
        const { commands } = await import('/src/editor/commands/index.ts')
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        void runCommand(commands.saveAs, 'button')
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

test('a reload after close() and before the binding: the next Save records the binding, adds no row and appends', async ({
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

    // A second reload past the marker, with nothing edited: the page journalled nothing, so the
    // load recovers nothing (the journal names only real entries).
    await page.reload()
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await waitForStartup(page)
    const reloaded = await rows(page, ['entries'])
    expect(reloaded.entries!.map((row) => row.value.kind)).not.toContain('recovered')

    // Unchanged: the earlier Save's binding is recorded, and nothing is written.
    await pressSave(page)
    await expect(
        notice(page).filter({ hasText: 'No changes since coconut.nxsp was saved' }),
    ).toBeVisible()
    expect(((await projectOf(page, 'coconut.nxsp')).revision as Record<string, unknown>).id).toBe(
        (written.revision as Record<string, unknown>).id,
    )
    // The binding keeps its handle: the next Save writes the file in place.
    await edit(page, 3)
    await pressSave(page)
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    // An append: no line about earlier steps.
    await expect(notice(page).filter({ hasText: 'Some earlier Timeline steps' })).toHaveCount(0)
    await expect(notice(page).filter({ hasText: 'Download started' })).toHaveCount(0)
    expect(await choice(page).count()).toBe(0)
    const revision = (await projectOf(page, 'coconut.nxsp')).revision as Record<string, unknown>
    const writtenId = (written.revision as Record<string, unknown>).id
    expect(revision.parent).toBe(writtenId)
    const { entries } = await rows(page, ['entries'])
    const saves = entries!.map((row) => row.value).filter((row) => row.kind === 'save')
    // The recognised Save has no row: its state is the one before it.
    expect(saves.map((row) => row.revisionId)).not.toContain(writtenId)
    expect(saves).toHaveLength(2)
    const chain = await chainOf(page)
    expect(chain.revision).toMatchObject({ id: revision.id })
})

test('a write that never landed leaves no marker, and a load drops markers of chains that are gone', async ({
    page,
}) => {
    await start(page)
    await savedOnce(page)
    const { chainId } = await chainOf(page)
    const marker = `sonolus-next-sekai-editor.saving.${String(chainId)}`
    // Changed just before close(): the write is aborted, so no marker of it stays.
    await edit(page, 2)
    await page.evaluate(() => localStorage.setItem('nse.test.savePause', 'beforeClose'))
    await pressSave(page)
    await expect
        .poll(() => page.evaluate(() => window.nseSaveTest?.reached ?? []))
        .toContain('beforeClose')
    expect(await page.evaluate((key) => localStorage.getItem(key), marker)).not.toBeNull()
    await writeFile(page, 'coconut.nxsp', [1, 2, 3])
    await page.evaluate(() => {
        localStorage.removeItem('nse.test.savePause')
        window.nseSaveTest?.release()
    })
    await expect(choice(page)).toContainText('“coconut.nxsp” Changed')
    expect(await page.evaluate((key) => localStorage.getItem(key), marker)).toBeNull()

    // A marker whose chain storage no longer holds goes at a later load.
    const stale = 'sonolus-next-sekai-editor.saving.gone-chain'
    await page.evaluate((key) => localStorage.setItem(key, '{}'), stale)
    await page.reload()
    await waitForStartup(page)
    await expect
        .poll(() => page.evaluate((key) => localStorage.getItem(key), stale), { timeout: 10_000 })
        .toBeNull()
})

test('after a reload, the bound file’s handle is read on the first edit, ahead of a Save', async ({
    page,
}) => {
    await start(page)
    await savedOnce(page)
    await page.reload()
    await waitForStartup(page)
    const reads = () =>
        page.evaluate(
            () => window.nseStorageTest!.worker.call('testHandleReads') as Promise<number>,
        )
    expect(await reads()).toBe(0)
    await edit(page, 2)
    await expect.poll(reads).toBeGreaterThan(0)
})

test('a Save whose handle read fails over the real client downloads nothing and keeps the binding; the next press writes in place', async ({
    page,
}) => {
    await start(page)
    await savedOnce(page)
    await page.reload()
    await waitForStartup(page)
    // The worker stops answering `readHandle` (the page's call to it rejects), as after a restart.
    await page.evaluate(() => {
        const worker = window.nseStorageTest!.worker
        const flags = window as unknown as { failHandleReads?: boolean }
        flags.failHandleReads = true
        worker.call = new Proxy(worker.call, {
            apply(target, thisArg: unknown, args: [string, ...unknown[]]) {
                if (flags.failHandleReads && args[0] === 'readHandle')
                    return Promise.reject(new Error('The storage worker stopped (spec)'))
                return Reflect.apply(target, thisArg, args) as unknown
            },
        })
    })
    const downloads: string[] = []
    page.on('download', (download) => downloads.push(download.suggestedFilename()))
    const before = await readFile(page, 'coconut.nxsp')
    await edit(page, 2)
    await pressSave(page)
    await expect(
        notice(page).filter({
            hasText:
                'Not saved. The editor could not access this browser’s storage. Try again, or use Save As.',
        }),
    ).toBeVisible()
    expect(downloads).toEqual([])
    expect(await readFile(page, 'coconut.nxsp')).toEqual(before)
    expect((await chainOf(page)).file).toMatchObject({ name: 'coconut.nxsp', event: 'saved' })
    // The next press reads again, finds the handle and writes in place.
    await page.evaluate(() => {
        ;(window as unknown as { failHandleReads?: boolean }).failHandleReads = false
    })
    await pressSave(page)
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    expect(downloads).toEqual([])
    expect(await readFile(page, 'coconut.nxsp')).not.toEqual(before)
    expect(await pickerCalls(page)).toHaveLength(1)
})

test('Save As… still saves while every covered storage read fails, as the Not saved line says', async ({
    page,
}) => {
    await start(page)
    await savedOnce(page)
    await page.reload()
    await waitForStartup(page)
    // The gate's reads all reject, as when the storage worker answers nothing it is asked to read.
    await page.evaluate(() => {
        const covered = new Set([
            'readHandle',
            'listHandleOwners',
            'readBindings',
            'readChainRecord',
            'replaceDecision',
            'openEarlierChains',
            'openPendingImports',
            'openImportTarget',
            'listRecovered',
            'readRecovered',
            'findEdits',
        ])
        const worker = window.nseStorageTest!.worker
        worker.call = new Proxy(worker.call, {
            apply(target, thisArg: unknown, args: [string, ...unknown[]]) {
                if (covered.has(args[0]))
                    return Promise.reject(new Error('The storage worker stopped (spec)'))
                return Reflect.apply(target, thisArg, args) as unknown
            },
        })
    })
    await edit(page, 2)
    await pressSave(page)
    await expect(notice(page).filter({ hasText: 'Try again, or use Save As.' })).toBeVisible()
    await page.evaluate(async () => {
        const { commands } = await import('/src/editor/commands/index.ts')
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        void runCommand(commands.saveAs, 'button')
    })
    await submitSave(page, 'melt', 'Save As')
    await expect(notice(page).filter({ hasText: 'Saved to melt.nxsp' })).toBeVisible()
    expect(await projectOf(page, 'melt.nxsp')).toMatchObject({ revision: { n: 1 } })
})
