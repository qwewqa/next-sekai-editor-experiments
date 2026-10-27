import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { executePlan, planNxsp, readNxsp } from '../../src/local/nxsp'
import { fresh } from '../local/nxsp/chain'
import { damagedFile } from '../local/open/files'
import { closePage, waitForStartup } from './editorFixture'
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
    submitSave,
    writeFile,
} from './saveFlows'

// A Save while an open's background import runs: it
// waits for the import inside "Preparing…", then appends; damage the import finds meanwhile
// unlinks the session and the Save goes on as Save As….
// Also: a kill right after the unlink with a pending journal comes back unlinked, and Undo right
// after a reload waits for the resumed import.

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
        'The history in coconut.nxsp is damaged. Saving will create a separate file.',
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
    await closePage(page, { runBeforeUnload: false })

    const next = await context.newPage()
    await next.goto('/')
    await waitForStartup(next)
    const { chains, entries } = await rows(next, ['chains', 'entries'])
    // The journal was replayed: a load that skipped it would leave the chain as it was.
    expect(
        entries!.some(
            (row) => row.value.sessionId === unlinked.head && row.value.kind === 'recovered',
        ),
    ).toBe(true)
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

test('a Save waiting for a held, multi-batch import shows its progress, and finishes after it', async ({
    page,
}) => {
    await start(page)
    await writeFile(page, 'coconut.nxsp', await freshBytes())
    // The import's second batch is held, so the first has committed and the rest has not.
    await page.evaluate(async () => {
        const { storageWorker } = await import('/src/local/start.ts')
        const worker = storageWorker!
        const call = worker.call.bind(worker)
        let release = () => {}
        const gate = new Promise<void>((resolve) => (release = resolve))
        const seen = window as unknown as { releaseImport: () => void; batches: number[] }
        seen.releaseImport = release
        seen.batches = []
        worker.call = (async (method: string, ...rest: unknown[]) => {
            if (method === 'openBatch') {
                const n = (rest[0] as { n: number }).n
                seen.batches.push(n)
                if (n === 1) await gate
            }
            return (call as (...args: unknown[]) => unknown)(method, ...rest)
        }) as typeof worker.call
    })
    await open(page, 'coconut.nxsp')
    await edit(page, 9)
    await pressSave(page)
    const preparing = page.getByRole('dialog').filter({ hasText: 'Preparing coconut.nxsp' })
    await expect(preparing).toBeVisible()
    const bar = preparing.getByRole('progressbar')
    await expect(bar).toBeVisible()
    const now = Number(await bar.getAttribute('aria-valuenow'))
    expect(now).toBeGreaterThan(0)
    expect(now).toBeLessThan(100)
    await page.evaluate(() => (window as unknown as { releaseImport: () => void }).releaseImport())
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible({
        timeout: 15_000,
    })
    await expect(preparing).toHaveCount(0)
})

test('a progress listener that throws does not fail the import', async ({ page }) => {
    await start(page)
    await writeFile(page, 'coconut.nxsp', await freshBytes())
    // Once the import's first batch is asked for, a throwing listener joins and its outcome is kept.
    await page.evaluate(async () => {
        const { onImportProgress, whenImported } = await import('/src/local/open/importLoop.ts')
        const { storageWorker } = await import('/src/local/start.ts')
        const seen = window as unknown as { heard: number; outcome?: Promise<{ kind: string }> }
        seen.heard = 0
        const worker = storageWorker!
        const call = worker.call.bind(worker)
        worker.call = (async (method: string, ...rest: unknown[]) => {
            if (method === 'openBatch' && !seen.outcome) {
                // The session whose import is pending is the one this batch belongs to.
                const stored = (await call('testRows', ['sessions'])) as Record<
                    string,
                    { value: { id: string; importPending?: boolean } }[]
                >
                const id = stored.sessions!.find((row) => row.value.importPending)!.value.id
                onImportProgress(id, () => {
                    seen.heard++
                    throw new Error('a UI threw')
                })
                seen.outcome = whenImported(id)
            }
            return (call as (...args: unknown[]) => unknown)(method, ...rest)
        }) as typeof worker.call
    })
    await open(page, 'coconut.nxsp')
    await imported(page)
    expect(
        await page.evaluate(
            async () =>
                (await (window as unknown as { outcome: Promise<{ kind: string }> }).outcome).kind,
        ),
    ).toBe('done')
    expect(
        await page.evaluate(() => (window as unknown as { heard: number }).heard),
    ).toBeGreaterThan(0)
})

test('a worker restart during the import of a file picked without a handle: a Save keeps every row', async ({
    page,
}) => {
    await start(page, { fileSystemAccess: false })
    await slowImport(page, 600)
    // Once armed, the next batch's call is cut off by a restart as soon as it is posted.
    await page.evaluate(async () => {
        const { storageWorker } = await import('/src/local/start.ts')
        const worker = storageWorker!
        const call = worker.call.bind(worker)
        const inner = worker as unknown as {
            restart: (generation: number, why: string) => void
            generation: number
        }
        const seen = window as unknown as { armed?: boolean; cutOff?: string }
        worker.call = (async (method: string, ...rest: unknown[]) => {
            const reply = (call as (...args: unknown[]) => Promise<unknown>)(method, ...rest)
            if (method !== 'openBatch' || !seen.armed) return reply
            seen.armed = false
            // The call is posted after the client's wait for a ready worker, a few microtasks on.
            for (let i = 0; i < 10; i++) await Promise.resolve()
            inner.restart(inner.generation, 'a test restarted it')
            return reply.catch((error: Error) => {
                seen.cutOff = error.name
                throw error
            })
        }) as typeof worker.call
    })
    const choosing = page.waitForEvent('filechooser')
    await page.keyboard.press('o')
    await (
        await choosing
    ).setFiles({
        name: 'coconut.nxsp',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from(await freshBytes()),
    })
    await expect(notice(page).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    // Armed once the open is shown, so the restart cuts off only the import's call.
    await page.evaluate(() => {
        ;(window as unknown as { armed?: boolean }).armed = true
    })
    await edit(page, 9)
    const downloading = page.waitForEvent('download')
    await pressSave(page)
    await submitSave(page)
    const download = await downloading
    expect(await page.evaluate(() => (window as unknown as { cutOff?: string }).cutOff)).toBe(
        'WorkerRestartedError',
    )
    const read = await readNxsp(new Blob([await readFile(await download.path())]))
    if (read.kind !== 'nxsp' || !read.history) throw new Error('The saved file has no history')
    // The file's four rows, the open's own, the edit and the save.
    expect(read.history.entries).toHaveLength(7)
    expect(read.history.entries.filter((entry) => entry.kept === false)).toEqual([])
})
