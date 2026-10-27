import { expect, type Page } from '@playwright/test'
import { installTestPlatform, waitForStartup } from './editorFixture'

// Helpers for the Save core's specs: a stored page under the platform override,
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
        const { nativeOperation } =
            (await import('/tests/helpers/historySteps.ts')) as typeof import('../helpers/historySteps')
        pushState(
            nativeOperation(
                { id: 'nse.object.add', data: { subject: 'bpm', created: 1 } },
                'Added BPM change',
            ),
            transaction.commit([]),
        )
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

/**
 * The `project.json` of an OPFS `.nxsp`. A file a save is writing is not readable for a moment (a
 * NotReadableError), or not found for a moment as the write's swap file replaces it (a
 * NotFoundError), and a file a save picker returned is empty until the save's write closes, so a
 * read that finds any of these is tried again for up to 5 s.
 */
export const projectOf = (page: Page, name: string) =>
    page.evaluate(async (name) => {
        const root = await navigator.storage.getDirectory()
        const { ZipReader } =
            (await import('/src/zip/reader.ts')) as typeof import('../../src/zip/reader')
        const until = performance.now() + 5000
        for (;;) {
            let retry: unknown
            try {
                const file = await (await root.getFileHandle(name)).getFile()
                if (file.size === 0) retry = 'empty'
                else {
                    const reader = await ZipReader.open(file)
                    const entry = reader.get('project.json')!
                    const bytes = await reader.read(entry, { maxSize: 4_000_000 })
                    return JSON.parse(new TextDecoder().decode(bytes)) as Row
                }
            } catch (error) {
                if (!['NotReadableError', 'NotFoundError'].includes((error as Error).name))
                    throw error
                retry = error
            }
            if (performance.now() > until)
                throw new Error(
                    `${name} was still ${retry === 'empty' ? 'empty' : 'unreadable'} after 5 s`,
                    retry === 'empty' ? undefined : { cause: retry },
                )
            await new Promise((resolve) => setTimeout(resolve, 50))
        }
    }, name)

/** Queues what the override's next pickers return; null dismisses one. */
export const queuePicks = (page: Page, picks: (string | null)[]) =>
    page.evaluate((picks) => {
        localStorage.setItem('nse.test.picks', JSON.stringify(picks))
    }, picks)

/** Every picker call the override logged. */
export const pickerCalls = (page: Page) =>
    page.evaluate(() => JSON.parse(localStorage.getItem('nse.test.pickerCalls') ?? '[]') as Row[])

/**
 * Holds the open's import until `releaseImport`, however slow the page is: at batch `n` (the
 * first by default), or with `'resume'` at a resumed import's read of the file, before the worker
 * has opened it. A spec that never releases it reloads or closes the page with the import pending.
 */
export const holdImport = (page: Page, at: number | 'resume' = 0) =>
    page.evaluate(async (at) => {
        const { storageWorker } = await import('/src/local/start.ts')
        const worker = storageWorker!
        const call = worker.call.bind(worker)
        let release = () => {}
        const gate = new Promise<void>((resolve) => (release = resolve))
        ;(window as unknown as { releaseImport: () => void }).releaseImport = release
        worker.call = (async (method: string, ...rest: unknown[]) => {
            const held =
                at === 'resume'
                    ? method === 'openResume'
                    : method === 'openBatch' && (rest[0] as { n: number }).n === at
            if (held) await gate
            return (call as (...args: unknown[]) => unknown)(method, ...rest)
        }) as typeof worker.call
    }, at)

export const releaseImport = (page: Page) =>
    page.evaluate(() => (window as unknown as { releaseImport: () => void }).releaseImport())

/**
 * From the next load on, the resume after startup (an idle callback with a 2 s timeout) waits
 * for `resumeImport`, or with `never` does not run.
 */
export const deferResume = (page: Page, { never = false } = {}) =>
    page.addInitScript((never) => {
        const idle = window.requestIdleCallback.bind(window)
        window.requestIdleCallback = (callback, options) => {
            if (callback.name !== 'run' || options?.timeout !== 2000) return idle(callback, options)
            if (!never)
                (window as unknown as { resumeImport: () => void }).resumeImport = () =>
                    callback({ didTimeout: true, timeRemaining: () => 0 })
            return 0
        }
    }, never)

/** Runs the startup resume that `deferResume` kept. */
export const resumeImport = (page: Page) =>
    page.evaluate(() => (window as unknown as { resumeImport: () => void }).resumeImport())

/** Whether this tab runs the open session's import. */
export const importing = (page: Page) =>
    page.evaluate(async () => {
        const { session } = await import('/src/history/session.ts')
        const { isImporting } = await import('/src/local/open/importLoop.ts')
        return isImporting(session.value.sessionId)
    })

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

export const undo = (page: Page) =>
    page.evaluate(async () => {
        const { undoState } =
            (await import('/src/history/index.ts')) as typeof import('../../src/history')
        undoState()
    })

/**
 * Edits, undoes and edits again, so one state leaves the stack: cleanup could take its row
 * (`thinUndone`).
 */
export const editPastUndo = async (page: Page, beat: number) => {
    await edit(page, beat)
    await edit(page, beat + 1)
    await undo(page)
    await edit(page, beat + 2)
}

/** Cleanup under pressure, as a test hook: an undone row (`editPastUndo`) made `kept: false`. */
export const thinUndone = async (page: Page) => {
    await flushed(page)
    const { entries } = await rows(page, ['entries'])
    const all = entries!
        .map((row) => row.value)
        .sort((a, b) =>
            a.sessionId === b.sessionId
                ? (a.seq as number) - (b.seq as number)
                : String(a.sessionId).localeCompare(String(b.sessionId)),
        )
    const undone = all.find(
        (row, i) =>
            row.kind === 'edit' &&
            all[i + 1]?.kind === 'undo' &&
            all[i + 1]?.sessionId === row.sessionId,
    )
    expect(undone).toBeDefined()
    return page.evaluate(
        (key) => window.nseStorageTest!.worker.call('testThin', key) as Promise<boolean>,
        { sessionId: undone!.sessionId as string, seq: undone!.seq as number },
    )
}

/**
 * Makes the storage worker's builds (`buildSave`) wait `ms` first, or fail when `ms` is `'fail'`,
 * or fail once and then run (`'failOnce'`), as a slow chart or a worker restart would;
 * `undefined` puts the worker's own call back.
 */
export const builds = (page: Page, ms: number | 'fail' | 'failOnce' | undefined) =>
    page.evaluate((ms) => {
        type Call = (method: string, ...rest: unknown[]) => Promise<unknown>
        const worker = window.nseStorageTest!.worker as unknown as { call: Call; ownCall?: Call }
        worker.ownCall ??= worker.call.bind(worker)
        const own = worker.ownCall
        let failures = ms === 'failOnce' ? 1 : ms === 'fail' ? Infinity : 0
        worker.call =
            ms === null
                ? own
                : (method, ...rest) => {
                      if (method !== 'buildSave') return own(method, ...rest)
                      if (failures > 0) {
                          failures--
                          return Promise.reject(new Error('The storage worker restarted'))
                      }
                      return typeof ms === 'number'
                          ? new Promise((resolve) => setTimeout(resolve, ms)).then(() =>
                                own(method, ...rest),
                            )
                          : own(method, ...rest)
                  }
    }, ms ?? null)

/** Whether the open session still holds a Save's reserved `seq` (edits after it wait). */
export const saveReserved = (page: Page) =>
    page.evaluate(
        () =>
            (window.nseFlushTest?.flusher as unknown as { session?: { reserved?: number } })
                ?.session?.reserved !== undefined,
    )

/**
 * Waits until the Save that wrote the file has stored its `save` entry. The file shows a write
 * before that, so call it once the file does, and before reading storage.
 */
export const saveStored = async (page: Page) => {
    await expect.poll(() => saveReserved(page)).toBe(false)
    await flushed(page)
}

/** The "Preparing…" dialog of a file, also once it says "Ready:" and waits for the press. */
export const preparingDialog = (page: Page, name = 'coconut.nxsp') =>
    page.getByRole('dialog').filter({
        hasText: new RegExp(`(Preparing|Ready:) ${name.replaceAll('.', '\\.')}`),
    })
