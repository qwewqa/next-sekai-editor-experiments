import { expect, type Page } from '@playwright/test'
import { installTestPlatform, waitForStartup } from './editorFixture'

// Helpers for the Save core's specs (Part 1 §1.4.7): a stored page under the platform override,
// edits through the history, OPFS files the override's pickers return, and storage rows.

type Row = Record<string, unknown>

export type Start = {
    fileSystemAccess?: boolean | 'opfs'
    /** Extra platform override fields, such as `activation`. */
    override?: Record<string, unknown>
    /** The storage worker's test flags, such as `forceQuota`. */
    storage?: Record<string, unknown>
}

/** Opens the editor with stored sessions, the override's pickers, and no preview or sidebar. */
export const start = async (
    page: Page,
    { fileSystemAccess = 'opfs', override = {}, storage = {} }: Start = {},
) => {
    await page.addInitScript((storage) => {
        localStorage.setItem('nse.test.storage', JSON.stringify(storage))
        localStorage.setItem('sonolus-next-sekai-editor.showPreview', 'false')
        localStorage.setItem('sonolus-next-sekai-editor.showSidebar', 'false')
        localStorage.setItem(
            'nse.test.version',
            JSON.stringify({ appVersion: '0.6.0', atTag: true }),
        )
        localStorage.setItem('sonolus-next-sekai-editor.lastAppVersion', JSON.stringify('0.6.0'))
    }, storage)
    await page.addInitScript(installTestPlatform, { fileSystemAccess, ...override })
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await waitForStartup(page)
}

/** An edit: a BPM change at a new beat, through the history as a tool's edit is. */
export const edit = (page: Page, beat: number) =>
    page.evaluate(async (beat) => {
        const { pushState, state } =
            (await import('/src/history/index.ts')) as typeof import('../../src/history')
        const { createTransaction } =
            (await import('/src/state/transaction.ts')) as typeof import('../../src/state/transaction')
        const { addBpm } =
            (await import('/src/state/mutations/bpm.ts')) as typeof import('../../src/state/mutations/bpm')
        const transaction = createTransaction(state.value)
        addBpm(transaction, { beat, bpm: 100 + beat })
        pushState(() => 'Added BPM change', transaction.commit([]))
    }, beat)

/** Writes an OPFS file, as another program would. */
export const writeFile = (page: Page, name: string, bytes: number[] | Uint8Array) =>
    page.evaluate(
        async ({ name, bytes }) => {
            const root = await navigator.storage.getDirectory()
            const handle = await root.getFileHandle(name, { create: true })
            const writable = await handle.createWritable()
            await writable.write(new Uint8Array(bytes))
            await writable.close()
        },
        { name, bytes: [...bytes] },
    )

/** An OPFS file's bytes, or undefined when there's none. */
export const readFile = (page: Page, name: string) =>
    page.evaluate(async (name) => {
        const root = await navigator.storage.getDirectory()
        try {
            const file = await (await root.getFileHandle(name)).getFile()
            return [...new Uint8Array(await file.arrayBuffer())]
        } catch {
            return undefined
        }
    }, name)

export const removeFile = (page: Page, name: string) =>
    page.evaluate(async (name) => {
        const root = await navigator.storage.getDirectory()
        await root.removeEntry(name)
    }, name)

/** The `project.json` of an OPFS `.nxsp`. */
export const projectOf = (page: Page, name: string) =>
    page.evaluate(async (name) => {
        const root = await navigator.storage.getDirectory()
        const file = await (await root.getFileHandle(name)).getFile()
        const { ZipReader } =
            (await import('/src/zip/reader.ts')) as typeof import('../../src/zip/reader')
        const reader = await ZipReader.open(file)
        const entry = reader.get('project.json')!
        const bytes = await reader.read(entry, { maxSize: 4_000_000 })
        return JSON.parse(new TextDecoder().decode(bytes)) as Row
    }, name)

/** Queues what the override's next pickers return; null dismisses one. */
export const queuePicks = (page: Page, picks: (string | null)[]) =>
    page.evaluate((picks) => {
        localStorage.setItem('nse.test.picks', JSON.stringify(picks))
    }, picks)

/** Every picker call the override logged. */
export const pickerCalls = (page: Page) =>
    page.evaluate(() => JSON.parse(localStorage.getItem('nse.test.pickerCalls') ?? '[]') as Row[])

export const rows = (page: Page, stores: string[]) =>
    page.evaluate(
        (stores) =>
            window.nseStorageTest!.worker.call('testRows', stores) as Promise<
                Record<string, { key: unknown; value: Row }[]>
            >,
        stores,
    )

export const sessionOf = (page: Page) =>
    page.evaluate(async () => {
        const { session } =
            (await import('/src/history/session.ts')) as typeof import('../../src/history/session')
        return session.value
    })

/** The chain record whose head is the open session. */
export const chainOf = async (page: Page) => {
    const { sessionId } = await sessionOf(page)
    const { chains } = await rows(page, ['chains'])
    return chains!.find((row) => row.value.head === sessionId)!.value
}

export const notice = (page: Page) => page.locator('.notification, .notification-pill')

/** The open Save dialog, by its title. */
export const saveDialog = (page: Page, title = 'Save Project File') =>
    page.getByRole('dialog').filter({ hasText: title })

/** Fills the Save dialog's File Name and presses Save. */
export const submitSave = async (page: Page, name?: string, title?: string) => {
    const dialog = saveDialog(page, title)
    await expect(dialog).toBeVisible()
    if (name !== undefined) await dialog.getByRole('textbox').fill(name)
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
}

/** Presses p, Save's key, with the chart focused. */
export const pressSave = async (page: Page) => {
    await page
        .locator('canvas.editor-chart')
        .focus()
        .catch(() => undefined)
    await page.keyboard.press('p')
}

/** Waits for every pending flush, so storage holds what the tab does. */
export const flushed = (page: Page) =>
    page.evaluate(async () => {
        const flusher = window.nseFlushTest?.flusher
        await flusher?.flush({ strict: true })
    })

/** Pauses the next write at a named point (`savePoint`); `release` lets it go on. */
export const pauseAt = (page: Page, point: string) =>
    page.evaluate((point) => localStorage.setItem('nse.test.savePause', point), point)

/** Waits until a page's write reached a point. */
export const reached = (page: Page, point: string) =>
    expect.poll(() => page.evaluate(() => window.nseSaveTest?.reached ?? [])).toContain(point)

/** Stops pausing (the key is the context's), leaving a paused write waiting for `release`. */
export const unpause = (page: Page) =>
    page.evaluate(() => localStorage.removeItem('nse.test.savePause'))

export const release = (page: Page) =>
    page.evaluate(() => {
        localStorage.removeItem('nse.test.savePause')
        window.nseSaveTest?.release()
    })

/** Whether closing the page now would raise the browser's prompt (the handler held the event). */
export const prompts = (page: Page) =>
    page.evaluate(() => {
        const event = new Event('beforeunload', { cancelable: true })
        window.dispatchEvent(event)
        return event.defaultPrevented
    })

/** The chain record of a chain, by id. */
export const chainById = async (page: Page, chainId: unknown) => {
    const { chains } = await rows(page, ['chains'])
    return chains!.map((row) => row.value).find((row) => row.chainId === chainId)
}
