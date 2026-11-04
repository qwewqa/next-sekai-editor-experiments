import { expect, test, type Download, type Page } from '@playwright/test'
import { readFile as readFileBytes } from 'node:fs/promises'
import { gunzipSync, gzipSync } from 'node:zlib'
import { readNxsp } from '../../src/local/nxsp'
import { crafted } from '../local/nxsp/craft'
import { closePage, waitForStartup } from './editorFixture'
import {
    chainById,
    chainOf,
    edit,
    flushed,
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
    refusingPicker,
    refusingPicks,
    release,
    rows,
    saveDialog,
    sessionOf,
    start,
    submitSave,
    writeFile,
    type Refusal,
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
    await expect(dialog).toContainText(
        '“coconut.nxsp” was replaced. Saving will create a separate file.',
    )
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

test('Save As onto its own file creates a new document', async ({ page }) => {
    await start(page)
    await savedTo(page, 'coconut.nxsp')
    const first = await projectOf(page, 'coconut.nxsp')
    await edit(page, 2)
    await saveAs(page)
    await expect(saveDialog(page, 'Save As').getByRole('textbox')).toHaveValue('coconut (2)')
    await queuePicks(page, ['coconut.nxsp'])
    await submitSave(page, undefined, 'Save As')
    await expect.poll(async () => (await projectOf(page, 'coconut.nxsp')).id).not.toBe(first.id)
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
    expect((project.revision as Row).parent).toBeNull()
    expect(project.id).not.toBe(first.id)
})

test('Save As replaces its own changed file after the picker confirms it', async ({ page }) => {
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
    await submitSave(page, undefined, 'Save As')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    await expect.poll(() => readFile(page, 'coconut.nxsp')).not.toEqual(changed)
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

test('an empty File Name saves its placeholder, numbered past a known file as a name is', async ({
    page,
}) => {
    await start(page)
    await edit(page, 1)
    await pressSave(page)
    const field = saveDialog(page).getByRole('textbox', { name: 'File Name' })
    await expect(field).toHaveAttribute('placeholder', 'Untitled')
    await submitSave(page)
    await expect(notice(page).filter({ hasText: 'Saved to Untitled.nxsp' })).toBeVisible()
    await expect
        .poll(async () => (await chainOf(page)).file)
        .toMatchObject({ name: 'Untitled.nxsp', event: 'saved' })
    const first = await chainOf(page)
    // A second untitled chart.
    await page.evaluate(async () => {
        const { resetState } = await import('/src/history/index.ts')
        resetState(false)
    })
    await edit(page, 2)
    await pressSave(page)
    await expect(field).toHaveValue('')
    await expect(field).toHaveAttribute('placeholder', 'Untitled (2)')
    await submitSave(page)
    await expect(notice(page).filter({ hasText: 'Saved to Untitled (2).nxsp' })).toBeVisible()
    expect((await pickerCalls(page)).map((call) => call.suggestedName)).toEqual([
        'Untitled.nxsp',
        'Untitled (2).nxsp',
    ])
    // The first chart keeps its file.
    const kept = (await chainById(page, first.chainId))!
    expect(kept.file).toMatchObject({ name: 'Untitled.nxsp' })
    expect(kept.replaced).toBeUndefined()
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

// Save accepts level data gzipped by the browser or by zlib at level 9.
for (const [compression, variant] of [
    ["the browser's stream", 0],
    ['level 9', 1],
] as const)
    test(`Save replaces opened level data gzipped by ${compression} with a project`, async ({
        page,
    }) => {
        await start(page)
        const built = await page.evaluate(async () => {
            const { buildLevelData } = await import('/src/editor/commands/exportLevel/build.ts')
            return [...new Uint8Array(await (await buildLevelData()).arrayBuffer())]
        })
        const level =
            variant === 0 ? built : [...gzipSync(gunzipSync(Buffer.from(built)), { level: 9 })]
        await writeFile(page, 'LevelData', level)
        await queuePicks(page, ['LevelData'])
        await page.keyboard.press('o')
        await expect(notice(page).filter({ hasText: 'Opened level' })).toBeVisible()
        await queuePicks(page, ['LevelData'])
        await pressSave(page)
        await submitSave(page, 'LevelData')
        await expect(notice(page).filter({ hasText: 'Saved to LevelData' })).toBeVisible()
        expect((await projectOf(page, 'LevelData')).id).toBe((await chainOf(page)).docId)
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

test("with storing paused, Save writes and the owner's stale binding finds a conflict after reload", async ({
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
    await expect(notice(a).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    const written = await readFile(a, 'coconut.nxsp')

    await b.reload()
    await waitForStartup(b)
    const { chains } = await rows(b, ['chains'])
    const after = chains!.map((row) => row.value).find((row) => row.chainId === bChain.chainId)!
    expect(after.file).toMatchObject({ name: 'coconut.nxsp', at: (bChain.file as Row).at })
    expect(after.replaced).toBeUndefined()
    await edit(b, 2)
    await pressSave(b)
    await expect(b.getByRole('dialog')).toContainText('“coconut.nxsp” Changed')
    expect(await readFile(b, 'coconut.nxsp')).toEqual(written)
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
    await expect(page.getByRole('dialog')).toContainText(
        'The contents of “coconut.nxsp” have changed.',
    )
    expect(await readFile(page, 'coconut.nxsp')).toEqual([1, 2, 3, 4])
})

test('a kill after revocation leaves the session unbound and the picked file empty', async ({
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
    expect((await sessionOf(next)).file).toBeUndefined()
    await pressSave(next)
    await expect(saveDialog(next)).toBeVisible()
    expect(await readFile(next, 'coconut.nxsp')).toEqual([])
})

test("B mid-write: A's pick waits for B to finish, then refuses the filled file", async ({
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
    await expect(a.getByRole('dialog')).toContainText(
        'The contents of “coconut.nxsp” have changed.',
    )
    expect((await projectOf(a, 'coconut.nxsp')).id).toBe(bChain.docId)
    const { chains } = await rows(a, ['chains'])
    const revoked = chains!.map((row) => row.value).find((row) => row.chainId === bChain.chainId)!
    expect(revoked.file).toMatchObject({ name: 'coconut.nxsp' })
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
        '“coconut.nxsp” was replaced. Saving will create a separate file.',
    )
})

test('Save replaces the original file of a partial open with the requested project', async ({
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
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    expect(await readFile(page, 'coconut.nxsp')).not.toEqual(bytes)
    expect((await projectOf(page, 'coconut.nxsp')).id).toBe((await chainOf(page)).docId)
})

// A browser that refuses reading, or writing, the file its save picker returned (Chrome for
// Android refuses getFile()). The press keeps its activation, so a download needs no Ready press.
const refusingStart = async (page: Page, refusal: Refusal) => {
    await refusingPicker(page, refusal)
    await start(page, { fileSystemAccess: true, override: { activation: true } })
}

for (const read of ['always', 'afterClose'] as const)
    test(`a picked file refusing reads ${read === 'always' ? 'from the start' : 'after its write'} is saved, and the next Save picks again`, async ({
        page,
    }) => {
        await refusingStart(page, { read })
        await edit(page, 1)
        // Save As for one, a first Save for the other: both go through the pick session.
        if (read === 'always') await saveAs(page)
        else await pressSave(page)
        await submitSave(page, 'coconut', read === 'always' ? 'Save As' : undefined)
        await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
        await expect(page.getByRole('dialog')).toHaveCount(0)
        const first = await projectOf(page, 'coconut.nxsp')
        // Nothing was read back, so the binding has no disk state to check the file by.
        await expect
            .poll(async () => (await chainOf(page)).file)
            .toMatchObject({
                name: 'coconut.nxsp',
                event: 'saved',
            })
        expect((await chainOf(page)).file).not.toHaveProperty('disk')
        await edit(page, 2)
        await pressSave(page)
        await expect.poll(() => refusingPicks(page)).toEqual(['coconut.nxsp', 'coconut.nxsp'])
        await expect
            .poll(async () => (await projectOf(page, 'coconut.nxsp')).revision)
            .not.toEqual(first.revision)
        await expect(page.getByRole('dialog')).toHaveCount(0)
    })

test('a bound file whose reads are refused later is picked again at Save, never refused as a write', async ({
    page,
}) => {
    await refusingStart(page, { read: 'onFlag' })
    await savedTo(page, 'coconut.nxsp')
    // Read back and checked: the binding has its disk state.
    expect((await chainOf(page)).file).toHaveProperty('disk')
    const first = await projectOf(page, 'coconut.nxsp')
    await page.evaluate(() => Reflect.set(window, 'refuseReads', true))
    await edit(page, 2)
    await pressSave(page)
    await expect.poll(() => refusingPicks(page)).toEqual(['coconut.nxsp', 'coconut.nxsp'])
    await expect
        .poll(async () => (await projectOf(page, 'coconut.nxsp')).revision)
        .not.toEqual(first.revision)
    expect((await projectOf(page, 'coconut.nxsp')).id).toBe(first.id)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByText('The browser did not allow writing')).toHaveCount(0)
})

for (const write of ['create', 'write', 'close'] as const)
    test(`a picked file refusing reads and ${write} gets nothing; the project downloads once, bound by name`, async ({
        page,
    }) => {
        await refusingStart(page, { read: 'always', write })
        const downloads: Download[] = []
        page.on('download', (download) => downloads.push(download))
        await edit(page, 1)
        await pressSave(page)
        await submitSave(page, 'coconut')
        await expect(
            notice(page).filter({ hasText: 'Download started: coconut.nxsp' }),
        ).toBeVisible()
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await expect.poll(() => downloads.length).toBe(1)
        expect(downloads[0]!.suggestedFilename()).toBe('coconut.nxsp')
        const bytes = await readFileBytes(await downloads[0]!.path())
        // A whole ZIP: its end record closes the file.
        expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04])
        expect([...bytes.subarray(-22, -18)]).toEqual([0x50, 0x4b, 0x05, 0x06])
        expect(await readFile(page, 'coconut.nxsp')).toEqual([])
        await expect
            .poll(async () => (await chainOf(page)).file)
            .toMatchObject({
                name: 'coconut.nxsp',
                event: 'downloaded',
            })
        const chain = await chainOf(page)
        const { handles } = await rows(page, ['handles'])
        expect(handles!.filter((row) => row.value.chainId === chain.chainId)).toEqual([])
        // The Timeline's save entry and the one in the downloaded file both say it downloaded.
        const read = await readNxsp(new Blob([bytes]))
        if (read.kind !== 'nxsp' || !read.history) throw new Error('The download has no history')
        const inFile = read.history.entries.filter((entry) => entry.kind === 'save')
        expect(JSON.stringify(inFile.at(-1)?.operation)).toContain('"delivery":"download"')
        await flushed(page)
        const { entries } = await rows(page, ['entries'])
        const stored = entries!.filter((row) => row.value.kind === 'save')
        expect(stored).toHaveLength(1)
        expect(JSON.stringify(stored[0]!.value.operation)).toContain('"delivery":"download"')
    })

test("Recent Sessions' Save… to a picked file refusing reads writes it and binds nothing", async ({
    page,
}) => {
    await refusingStart(page, { read: 'always' })
    await edit(page, 1)
    await flushed(page)
    const earlier = await sessionOf(page)
    await page.evaluate(async () => {
        const { resetState } = await import('/src/history/index.ts')
        resetState(false)
    })
    await edit(page, 2)
    await flushed(page)
    const open = await chainOf(page)
    await page.evaluate((sessionId) => {
        void import('/src/editor/save/flow.ts').then((flow) => flow.saveToFile(sessionId))
    }, earlier.sessionId)
    await submitSave(page, 'restored')
    await expect(notice(page).filter({ hasText: 'Saved to restored.nxsp' })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect((await projectOf(page, 'restored.nxsp')).revision).toBeDefined()
    const { chains } = await rows(page, ['chains'])
    expect(
        chains!.some((row) => (row.value.file as Row | undefined)?.name === 'restored.nxsp'),
    ).toBe(false)
    expect((await chainOf(page)).file).toEqual(open.file)
})
