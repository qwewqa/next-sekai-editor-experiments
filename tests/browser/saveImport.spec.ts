import { expect, test, type Page } from '@playwright/test'
import { executePlan, planNxsp } from '../../src/local/nxsp'
import { fresh } from '../local/nxsp/chain'
import { damagedFile } from '../local/open/files'
import { waitForStartup } from './editorFixture'
import {
    chainOf,
    edit,
    notice,
    pressSave,
    projectOf,
    queuePicks,
    rows,
    saveDialog,
    sessionOf,
    start,
    writeFile,
} from './saveFlows'

// A Save while an open's background import runs (Part 1 §1.4.7, §1.5.4; r12-arch-web M6): it
// waits for the import inside "Preparing…", then appends; damage the import finds meanwhile
// unlinks the session and the Save goes on as Save As…. And two follow-ups of the open package:
// a kill right after the unlink with a pending journal comes back unlinked, and Undo right after a
// reload waits for the resumed import.

type Row = Record<string, unknown>

const freshBytes = async () =>
    new Uint8Array(await (await executePlan(planNxsp(fresh().input).plan, new Map())).arrayBuffer())

const damagedBytes = async () => new Uint8Array(await (await damagedFile()).file.arrayBuffer())

const slowImport = (page: Page, ms: number) =>
    page.evaluate((ms) => {
        localStorage.setItem('nse.test.importDelay', String(ms))
    }, ms)

const open = async (page: Page, name: string) => {
    await queuePicks(page, [name])
    await page.keyboard.press('o')
    await expect(notice(page).filter({ hasText: name }).first()).toBeVisible()
}

const imported = (page: Page) =>
    expect
        .poll(async () => {
            const { sessions } = await rows(page, ['sessions'])
            return sessions!.filter((row) => row.value.importPending === true).length
        })
        .toBe(0)

test('a Save waits for the import, then appends to the file', async ({ page }) => {
    await start(page)
    await writeFile(page, 'coconut.nxsp', await freshBytes())
    await slowImport(page, 700)
    await open(page, 'coconut.nxsp')
    await edit(page, 9)
    await pressSave(page)
    // The Save waits inside "Preparing coconut.nxsp…".
    await expect(
        page.getByRole('dialog').filter({ hasText: 'Preparing coconut.nxsp' }),
    ).toBeVisible()
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible({
        timeout: 15_000,
    })
    const project = await projectOf(page, 'coconut.nxsp')
    expect((project.revision as Row).parent).toBe('r001-0000-4000-8000-000000000000')
    expect((project.history as Row).entries).toBe(7)
})

test('damage the import finds while a Save waits: the session unlinks, and Save As… follows', async ({
    page,
}) => {
    await start(page)
    await writeFile(page, 'coconut.nxsp', await damagedBytes())
    const before = [...(await damagedBytes())]
    await slowImport(page, 700)
    await open(page, 'coconut.nxsp')
    await edit(page, 9)
    await pressSave(page)
    const saveAs = saveDialog(page, 'Save As')
    await expect(saveAs).toContainText(
        '"coconut.nxsp" has damaged history. Saving makes a separate file.',
        { timeout: 15_000 },
    )
    await expect(saveAs.getByRole('textbox')).toHaveValue(/\(2\)$/)
    // The opened file is untouched.
    const bytes = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory()
        const file = await (await root.getFileHandle('coconut.nxsp')).getFile()
        return [...new Uint8Array(await file.arrayBuffer())]
    })
    expect(bytes).toEqual(before)
    expect((await sessionOf(page)).file).toBeUndefined()
})

test('a kill right after the unlink, with a pending journal, comes back unlinked', async ({
    context,
}) => {
    const page = await context.newPage()
    await start(page)
    await writeFile(page, 'coconut.nxsp', await damagedBytes())
    await open(page, 'coconut.nxsp')
    await imported(page)
    const unlinked = await chainOf(page)
    expect(unlinked.file).toBeUndefined()
    // Edits only the journal holds, then the tab dies.
    await page.evaluate(() => {
        window.nseFlushTest!.stall = true
    })
    await edit(page, 9)
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
        document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.close({ runBeforeUnload: false })

    const next = await context.newPage()
    await next.goto('/')
    await waitForStartup(next)
    const { chains } = await rows(next, ['chains'])
    const chain = chains!.map((row) => row.value).find((row) => row.chainId === unlinked.chainId)!
    expect(chain.docId).toBe(unlinked.docId)
    expect(chain.file).toBeUndefined()
    expect(chain.revision).toBeUndefined()
})

test('Undo right after a reload mid-import waits for the resumed import', async ({ page }) => {
    await start(page)
    await writeFile(page, 'coconut.nxsp', await freshBytes())
    await slowImport(page, 1500)
    await open(page, 'coconut.nxsp')
    const chain = await chainOf(page)
    const { handles } = await rows(page, ['handles'])
    const token = (
        handles!.find((row) => row.value.chainId === chain.chainId)!.value.handle as {
            testHandle: string
        }
    ).testHandle
    // The next load reads the handle back as a fake one: a spec cannot hold a real OPFS handle.
    await page.addInitScript(
        ({ token, name }) => {
            localStorage.setItem('nse.test.importDelay', '300')
            const opfs = async () => (await navigator.storage.getDirectory()).getFileHandle(name)
            const handle = {
                kind: 'file',
                name,
                getFile: async () => (await opfs()).getFile(),
                queryPermission: () => Promise.resolve('granted'),
                isSameEntry: (other: { name?: string }) => Promise.resolve(other.name === name),
            }
            window.nseTestHandles = new Map([[token, handle as unknown as FileSystemFileHandle]])
        },
        { token, name: 'coconut.nxsp' },
    )
    await page.reload()
    await waitForStartup(page)
    const notes = () =>
        page.evaluate(async () => {
            const { state } = await import('/src/history/index.ts')
            return [...state.value.store.slides.note.values()].flat().length
        })
    const before = await notes()
    // At once: the earlier states' chunks may not be imported yet.
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+z')
    await expect.poll(notes, { timeout: 15_000 }).toBe(before - 1)
})
