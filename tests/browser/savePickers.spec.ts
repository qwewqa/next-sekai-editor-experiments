import { expect, test, type Page } from '@playwright/test'
import { crafted } from '../local/nxsp/craft'
import { closePage, waitForStartup } from './editorFixture'
import {
    chainById,
    chainOf,
    edit,
    notice,
    pauseAt,
    pickerCalls,
    preparingDialog,
    pressSave,
    projectOf,
    prompts,
    queuePicks,
    reached,
    readFile,
    release,
    rows,
    saveDialog,
    sessionOf,
    start,
    submitSave,
    writeFile,
} from './saveFlows'

// The save picker's rules
// on the Chromium override, whose picker empties an existing file as Chromium's does. Two pages
// of one context share OPFS, IndexedDB, Web Locks and BroadcastChannel.

type Row = Record<string, unknown>

const saveAs = (page: Page) =>
    page.evaluate(async () => {
        const { commands } = await import('/src/editor/commands/index.ts')
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        void runCommand(commands.saveAs, 'button')
    })

const savedTo = async (page: Page, name: string) => {
    await edit(page, 1)
    await pressSave(page)
    await submitSave(page, name.replace(/\.nxsp$/, ''))
    await expect(notice(page).filter({ hasText: `Saved to ${name}` })).toBeVisible()
    await expect.poll(async () => (await chainOf(page)).file).toMatchObject({ name })
}

test('a takeover: A picks the file B is bound to; B loses it passively and its next Save asks', async ({
    context,
}) => {
    const b = await context.newPage()
    await start(b)
    await savedTo(b, 'coconut.nxsp')
    const bChain = await chainOf(b)

    const a = await context.newPage()
    await start(a)
    await edit(a, 5)
    await queuePicks(a, ['coconut.nxsp'])
    await pressSave(a)
    await submitSave(a)
    await expect(notice(a).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    const written = await projectOf(a, 'coconut.nxsp')
    const aChain = await chainOf(a)
    expect(written.id).toBe(aChain.docId)
    expect((aChain.file as Row).name).toBe('coconut.nxsp')

    const { chains } = await rows(a, ['chains'])
    const revoked = chains!.map((row) => row.value).find((row) => row.chainId === bChain.chainId)!
    expect(revoked.file).toBeUndefined()
    expect(revoked.replaced).toMatchObject({ by: aChain.chainId, name: 'coconut.nxsp' })
    expect(revoked.edited).toBe(true)
    // It keeps the file's stem as its name: its row and label do not fall back to the title.
    expect(revoked.name).toBe('coconut')

    // B's label goes, with no notice (the broadcast, or becoming visible), and B prompts.
    await b.bringToFront()
    await expect.poll(async () => (await sessionOf(b)).file).toBeUndefined()
    expect((await sessionOf(b)).name).toBe('coconut')
    await expect(notice(b).filter({ hasText: 'replaced' })).toHaveCount(0)
    expect(await prompts(b)).toBe(true)
    await pressSave(b)
    const dialog = saveDialog(b)
    await expect(dialog).toContainText('“coconut.nxsp” was replaced from another tab or window.')
    await expect(dialog.getByRole('textbox')).toHaveValue('coconut (2)')
    await submitSave(b)
    await expect(notice(b).filter({ hasText: 'Saved to coconut (2).nxsp' })).toBeVisible()
    expect((await projectOf(b, 'coconut (2).nxsp')).id).toBe(bChain.docId)
})

/** Opens an OPFS file with its handle, as Open File… on a save picker's platform does. */
const openFile = (page: Page, name: string) =>
    page.evaluate(async (name) => {
        const root = await navigator.storage.getDirectory()
        const handle = await root.getFileHandle(name)
        const { openProject } = await import('/src/editor/commands/open/project.ts')
        await openProject(await handle.getFile(), handle)
    }, name)

test('opening the file just saved keeps the session; a copy of it elsewhere is a new chain', async ({
    page,
}) => {
    await start(page)
    await savedTo(page, 'coconut.nxsp')
    const saved = await chainOf(page)
    const { sessionId } = await sessionOf(page)
    await openFile(page, 'coconut.nxsp')
    await expect(notice(page).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Reopen/ })).toHaveCount(0)
    expect((await rows(page, ['chains'])).chains).toHaveLength(1)
    expect((await sessionOf(page)).sessionId).toBe(sessionId)

    // The same bytes at another path: the next Save must write the file the user opened.
    await writeFile(page, 'copy.nxsp', (await readFile(page, 'coconut.nxsp'))!)
    await openFile(page, 'copy.nxsp')
    await expect(notice(page).filter({ hasText: 'Opened copy.nxsp' })).toBeVisible()
    expect((await rows(page, ['chains'])).chains).toHaveLength(2)
    const opened = await chainOf(page)
    expect(opened.chainId).not.toBe(saved.chainId)
    expect(opened.file).toMatchObject({ name: 'copy.nxsp', event: 'opened' })
})

test('a self-pick at the base keeps the docId and ancestry, with no line', async ({ page }) => {
    await start(page)
    await savedTo(page, 'coconut.nxsp')
    const first = await projectOf(page, 'coconut.nxsp')
    await edit(page, 2)
    await saveAs(page)
    await expect(saveDialog(page, 'Save As').getByRole('textbox')).toHaveValue('coconut (2)')
    await queuePicks(page, ['coconut.nxsp'])
    await submitSave(page, undefined, 'Save As')
    await expect
        .poll(async () => ((await projectOf(page, 'coconut.nxsp')).revision as Row).parent)
        .toBe((first.revision as Row).id)
    expect((await projectOf(page, 'coconut.nxsp')).id).toBe(first.id)
    await expect(notice(page).filter({ hasText: 'Some earlier Timeline steps' })).toHaveCount(0)
})

test("a self-pick's file is empty from the pick until the write closes, then holds the next revision", async ({
    page,
}) => {
    await start(page)
    await savedTo(page, 'coconut.nxsp')
    const first = await projectOf(page, 'coconut.nxsp')
    await edit(page, 2)
    await saveAs(page)
    await queuePicks(page, ['coconut.nxsp'])
    await pauseAt(page, 'picked')
    await submitSave(page, undefined, 'Save As')
    await reached(page, 'picked')
    expect(await readFile(page, 'coconut.nxsp')).toEqual([])
    // A read of the emptied file waits for the save's write.
    const reading = projectOf(page, 'coconut.nxsp')
    await release(page)
    const project = await reading
    expect((project.revision as Row).parent).toBe((first.revision as Row).id)
    expect(project.id).toBe(first.id)
})

test("the chain's own file changed on disk: a pick puts its bytes back and opens the conflict dialog", async ({
    page,
}) => {
    await start(page)
    await savedTo(page, 'coconut.nxsp')
    // Another revision of the file, as another device would write it.
    await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory()
        const file = await (await root.getFileHandle('coconut.nxsp')).getFile()
        const bytes = new Uint8Array(await file.arrayBuffer())
        // The same length, another central directory.
        for (let i = 0; i + 4 < bytes.length; i++)
            if (
                bytes[i] === 0x50 &&
                bytes[i + 1] === 0x4b &&
                bytes[i + 2] === 1 &&
                bytes[i + 3] === 2
            ) {
                bytes[i + 4] = bytes[i + 4]! ^ 1
                break
            }
        const writable = await (await root.getFileHandle('coconut.nxsp')).createWritable()
        await writable.write(bytes)
        await writable.close()
    })
    const changed = await readFile(page, 'coconut.nxsp')
    await edit(page, 2)
    await saveAs(page)
    await queuePicks(page, ['coconut.nxsp'])
    // The read before the picker has time to finish.
    await page.waitForTimeout(500)
    await submitSave(page, undefined, 'Save As')
    await expect(page.getByRole('dialog')).toContainText('“coconut.nxsp” Changed')
    expect(await readFile(page, 'coconut.nxsp')).toEqual(changed)
})

test('Save As… suggests a dotted file name whole, as it is shown', async ({ page }) => {
    await start(page)
    await savedTo(page, 'feat. Miku.nxsp')
    await saveAs(page)
    // The shown name is the stem already: "feat. Miku", never cut again to "feat".
    await expect(saveDialog(page, 'Save As').getByRole('textbox')).toHaveValue('feat. Miku (2)')
})

test('suggestions never name a known file: a taken "(2)" gets one more', async ({ page }) => {
    await start(page)
    await savedTo(page, 'coconut.nxsp')
    await saveAs(page)
    await submitSave(page, undefined, 'Save As')
    await expect(notice(page).filter({ hasText: 'Saved to coconut (2).nxsp' })).toBeVisible()
    // The chain is bound to "coconut (2)" now; its Save As… suggests the next free name.
    await saveAs(page)
    await expect(saveDialog(page, 'Save As').getByRole('textbox')).toHaveValue('coconut (3)')
})

test('the project picker lists .nxsp only, and a build that outlasted the press asks for Save', async ({
    page,
}) => {
    await start(page, { override: { activation: false } })
    await edit(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
    const preparing = preparingDialog(page)
    await expect(preparing).toBeVisible()
    expect(await pickerCalls(page)).toEqual([])
    await page.waitForTimeout(350)
    await preparing.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    expect(await pickerCalls(page)).toHaveLength(1)
})

// Export compresses on the browser's stream; a file written at level 9 (an older export, or Firefox
// before 113) is rebuilt too.
for (const [compression, variant] of [
    ["the browser's stream", 0],
    ['level 9', 1],
] as const)
    test(`level data gzipped by ${compression}, opened in this tab and picked in the project picker, is refused and put back`, async ({
        page,
    }) => {
        await start(page)
        const level = await page.evaluate(async (variant) => {
            const { buildLevelDataVariants } =
                await import('/src/editor/commands/exportLevel/build.ts')
            const blob = (await buildLevelDataVariants())[variant]
            return [...new Uint8Array(await blob!.arrayBuffer())]
        }, variant)
        await writeFile(page, 'LevelData', level)
        await queuePicks(page, ['LevelData'])
        await page.keyboard.press('o')
        await expect(notice(page).filter({ hasText: 'Opened level' })).toBeVisible()
        await queuePicks(page, ['LevelData'])
        await pressSave(page)
        await submitSave(page, 'LevelData')
        const dialog = page.getByRole('dialog')
        await expect(dialog).toContainText('“LevelData” is not a project file.')
        await expect(dialog.getByRole('button', { name: 'Export Level Data…' })).toBeVisible()
        expect(await readFile(page, 'LevelData')).toEqual(level)
    })

test('a download browser downloads, binds by name, and offers Download Again unchanged', async ({
    page,
}) => {
    await page.addInitScript(() => {
        const downloads: string[] = []
        ;(window as { downloads?: string[] }).downloads = downloads
        HTMLAnchorElement.prototype.click = function () {
            downloads.push(this.download)
        }
    })
    await start(page, { fileSystemAccess: false })
    await edit(page, 1)
    await pressSave(page)
    await expect(saveDialog(page)).toBeVisible()
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Download started: coconut.nxsp' })).toBeVisible()
    expect(await chainOf(page)).toMatchObject({
        file: { name: 'coconut.nxsp', event: 'downloaded' },
    })
    // Unchanged: no new copy until Download Again.
    await pressSave(page)
    await expect(
        notice(page).filter({ hasText: 'No changes since coconut.nxsp was downloaded' }),
    ).toBeVisible()
    // A change downloads again with no dialog.
    await edit(page, 2)
    await pressSave(page)
    await expect
        .poll(() => page.evaluate(() => (window as { downloads?: string[] }).downloads?.length))
        .toBe(2)
    await expect(saveDialog(page)).toHaveCount(0)
    expect(await pickerCalls(page)).toEqual([])
})

test('a fork has no binding, and its first Save suggests "<name> (2)"', async ({ context }) => {
    const b = await context.newPage()
    await start(b)
    await savedTo(b, 'coconut.nxsp')
    // Restore as a Copy of B's session, open in B: a fork of B's chain.
    const { sessionId } = await sessionOf(b)
    const a = await context.newPage()
    await start(a)
    await a.evaluate(async (sessionId) => {
        const { restoreCopy } = await import('/src/editor/switch.ts')
        await restoreCopy(sessionId)
    }, sessionId)
    await expect.poll(async () => (await sessionOf(a)).copyOf?.name).toBe('coconut.nxsp')
    expect((await sessionOf(a)).file).toBeUndefined()
    await edit(a, 4)
    await pressSave(a)
    await expect(saveDialog(a).getByRole('textbox')).toHaveValue('coconut (2)')
})

test("Export's picker: the chain's own project file is refused and written again, keeping its identity", async ({
    page,
}) => {
    await start(page)
    await savedTo(page, 'coconut.nxsp')
    const before = await projectOf(page, 'coconut.nxsp')
    await queuePicks(page, ['coconut.nxsp'])
    await page.keyboard.press('Shift+P')
    const exporting = page.getByRole('dialog').filter({ hasText: 'Export Level Data' })
    await expect(exporting.locator('[data-export-name]')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toContainText('“coconut.nxsp” is not level data.')
    const after = await projectOf(page, 'coconut.nxsp')
    expect(after.id).toBe(before.id)
    expect((after.revision as Row).parent).toBe((before.revision as Row).id)
})

test("with storing paused, a takeover writes nothing, and the owner's binding stands across its reload", async ({
    context,
}) => {
    const b = await context.newPage()
    await start(b)
    await savedTo(b, 'coconut.nxsp')
    const bChain = await chainOf(b)

    const a = await context.newPage()
    await a.addInitScript(() => {
        sessionStorage.setItem('nse.test.storage', JSON.stringify({ forceQuota: true }))
    })
    await start(a)
    await edit(a, 5)
    await queuePicks(a, ['coconut.nxsp'])
    await pressSave(a)
    await submitSave(a)
    await expect(a.getByRole('dialog')).toContainText('“coconut.nxsp” could not be written.')

    await b.reload()
    await waitForStartup(b)
    const { chains } = await rows(b, ['chains'])
    const after = chains!.map((row) => row.value).find((row) => row.chainId === bChain.chainId)!
    expect(after.file).toMatchObject({ name: 'coconut.nxsp', at: (bChain.file as Row).at })
    expect(after.replaced).toBeUndefined()
})

test("Recent Sessions' Save… writes a session that isn't open as a new file, binding nothing", async ({
    page,
}) => {
    await start(page)
    await edit(page, 1)
    await savedTo(page, 'coconut.nxsp')
    const earlier = await sessionOf(page)
    const chain = await chainOf(page)
    // Another session in this tab.
    await page.evaluate(async () => {
        const { resetState } = await import('/src/history/index.ts')
        resetState(false)
    })
    await edit(page, 2)
    await page.evaluate((sessionId) => {
        void import('/src/editor/save/flow.ts').then((flow) => flow.saveToFile(sessionId))
    }, earlier.sessionId)
    const dialog = saveDialog(page)
    await expect(dialog.getByRole('textbox')).toHaveValue(/^coconut \(restored .+\)$/)
    await submitSave(page, 'restored')
    await expect(notice(page).filter({ hasText: 'Saved to restored.nxsp' })).toBeVisible()
    const written = await projectOf(page, 'restored.nxsp')
    expect(written.id).not.toBe(chain.docId)
    expect((written.revision as Row).parent).toBeNull()
    // The session's chain is as it was.
    const { chains } = await rows(page, ['chains'])
    const same = chains!.map((row) => row.value).find((row) => row.chainId === chain.chainId)!
    expect(same.file).toEqual(chain.file)
})

test('a sync client writing into the picked file after the pick: nothing is written over it', async ({
    page,
}) => {
    await start(page)
    await edit(page, 1)
    await pauseAt(page, 'picked')
    await queuePicks(page, ['coconut.nxsp'])
    await pressSave(page)
    await submitSave(page, 'coconut')
    await reached(page, 'picked')
    await writeFile(page, 'coconut.nxsp', [1, 2, 3, 4])
    await release(page)
    await expect(page.getByRole('dialog')).toContainText('“coconut.nxsp” Changed')
    expect(await readFile(page, 'coconut.nxsp')).toEqual([1, 2, 3, 4])
})

test('a kill after the revocation: the reload is bound to the emptied file, and Save fills it', async ({
    context,
}) => {
    const a = await context.newPage()
    await start(a)
    await edit(a, 1)
    await pauseAt(a, 'revoked')
    await queuePicks(a, ['coconut.nxsp'])
    await pressSave(a)
    await submitSave(a, 'coconut')
    await reached(a, 'revoked')
    expect(await readFile(a, 'coconut.nxsp')).toEqual([])
    await a.evaluate(() => localStorage.removeItem('nse.test.savePause'))
    await closePage(a, { runBeforeUnload: false })

    const next = await context.newPage()
    await next.goto('/')
    await waitForStartup(next)
    await expect.poll(async () => (await sessionOf(next)).file?.name).toBe('coconut.nxsp')
    await pressSave(next)
    await expect(notice(next).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    await expect(next.getByRole('dialog')).toHaveCount(0)
    expect((await readFile(next, 'coconut.nxsp'))!.length).toBeGreaterThan(0)
})

test("B mid-write: A's pick waits for B to finish, then takes the file over", async ({
    context,
}) => {
    const b = await context.newPage()
    await start(b)
    await savedTo(b, 'coconut.nxsp')
    const bChain = await chainOf(b)
    await edit(b, 2)
    await pauseAt(b, 'beforeClose')
    await pressSave(b)
    await reached(b, 'beforeClose')

    const a = await context.newPage()
    await start(a)
    await edit(a, 5)
    await queuePicks(a, ['coconut.nxsp'])
    await pressSave(a)
    await submitSave(a)
    // A waits on nse-bind while B holds it.
    await a.waitForTimeout(500)
    // A's picker emptied the file, and B's write hasn't closed.
    await expect.poll(() => readFile(b, 'coconut.nxsp')).toEqual([])
    await release(b)
    // B's check of the emptied file goes on without a conflict: its Save lands first.
    await expect
        .poll(async () => ((await chainById(a, bChain.chainId))?.revision as Row | undefined)?.n)
        .toBe(2)
    await expect(b.getByRole('dialog')).toHaveCount(0)
    await expect(notice(a).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible({
        timeout: 15_000,
    })
    expect((await projectOf(a, 'coconut.nxsp')).id).toBe((await chainOf(a)).docId)
    const { chains } = await rows(a, ['chains'])
    const revoked = chains!.map((row) => row.value).find((row) => row.chainId === bChain.chainId)!
    expect(revoked.file).toBeUndefined()
})

test("B frozen while A takes its file: once shown, B's label goes and its Save asks", async ({
    context,
}) => {
    const b = await context.newPage()
    await start(b)
    await savedTo(b, 'coconut.nxsp')
    const cdp = await context.newCDPSession(b)
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' })

    const a = await context.newPage()
    await start(a)
    await edit(a, 5)
    await queuePicks(a, ['coconut.nxsp'])
    await pressSave(a)
    await submitSave(a)
    await expect(notice(a).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()

    await cdp.send('Page.setWebLifecycleState', { state: 'active' })
    await b.bringToFront()
    await b.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    await expect.poll(async () => (await sessionOf(b)).file).toBeUndefined()
    await edit(b, 3)
    await pressSave(b)
    await expect(saveDialog(b)).toContainText(
        '“coconut.nxsp” was replaced from another tab or window.',
    )
})

test("a partial open's file picked in the project picker is refused and put back", async ({
    page,
}) => {
    await start(page)
    const file = await crafted((items) => {
        items.push({ name: 'video/clip.mp4', data: new Uint8Array([1, 2, 3]), method: 'store' })
    })
    const bytes = [...new Uint8Array(await file.arrayBuffer())]
    await writeFile(page, 'coconut.nxsp', bytes)
    await queuePicks(page, ['coconut.nxsp'])
    await page.keyboard.press('o')
    await expect(
        notice(page).filter({ hasText: 'This file was created by a newer version' }),
    ).toBeVisible()
    await edit(page, 3)
    await queuePicks(page, ['coconut.nxsp'])
    await pressSave(page)
    await submitSave(page)
    await expect(page.getByRole('dialog')).toContainText(
        'Not saved. “coconut.nxsp” could not be read in full.',
    )
    expect(await readFile(page, 'coconut.nxsp')).toEqual(bytes)
})
