import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { Dump } from '../../src/local/dump'
import { closePage } from '../browser/editorFixture'
import {
    chainById,
    chainOf,
    flushed,
    notice,
    pressSave,
    queuePicks,
    rows,
    saveDialog,
    sessionOf,
    submitSave,
} from '../browser/saveFlows'
import { dump, Editor, prefix, SampleClock, seedContext } from '../samples/driver'

// The writer's world (npm run fixtures:v1): one profile per device (a browser context with its own
// clock, OPFS and IndexedDB), pages that are open editors, and the plain helpers the steps share.

export const SECOND = 1000
export const MINUTE = 60 * SECOND
export const DAY = 24 * 60 * MINUTE

/** The first visit's time: all fixtures are written from times after it. */
export const START = Date.UTC(2026, 10, 2, 9, 0, 0)

export type Row = Record<string, unknown>

export type ProfileOptions = {
    /** Where the profile's clock starts. */
    start: number
    /** 'opfs': Chromium's save picker (write-back), on the override's OPFS handles; 'download': no pickers. */
    files: 'opfs' | 'download'
}

/** One device: its browser context, its clock and its pages. */
export class Profile {
    private constructor(
        readonly context: BrowserContext,
        readonly clock: SampleClock,
        readonly files: ProfileOptions['files'],
    ) {}

    /** Whether the profile has pressed Agree: the first editor page of each profile does. */
    private agreed = false

    static async create(browser: Browser, { start, files }: ProfileOptions) {
        const context = await browser.newContext({ timezoneId: 'UTC', locale: 'en-US' })
        const clock = new SampleClock(context, start)
        await clock.install()
        // No agreement record: the app writes it when the first page agrees, as a visitor's does.
        await seedContext(context, { agreement: false })
        // After seedContext: the platform for this device, the storage flags a step sets on the
        // profile (`nse.fixtures.flags`, never dumped), and the preview panel out of the way.
        await context.addInitScript(
            ({ files, prefix }) => {
                localStorage.setItem(
                    'nse.test.platform',
                    JSON.stringify({ fileSystemAccess: files === 'opfs' ? 'opfs' : false }),
                )
                localStorage.setItem(
                    'nse.test.storage',
                    localStorage.getItem('nse.fixtures.flags') ?? '{}',
                )
                localStorage.setItem(`${prefix}showPreview`, 'false')
                localStorage.setItem(`${prefix}showMinimap`, 'false')
            },
            { files, prefix },
        )
        return new Profile(context, clock, files)
    }

    /** The storage worker's test flags for the loads that follow. */
    async flags(page: Page, flags: Record<string, unknown> | undefined) {
        await page.evaluate(
            (text) => {
                if (text === undefined) localStorage.removeItem('nse.fixtures.flags')
                else localStorage.setItem('nse.fixtures.flags', text)
            },
            flags && JSON.stringify(flags),
        )
    }

    /** A new tab: a visit that continues the newest session, or starts blank. */
    async visit() {
        const page = await this.context.newPage()
        this.clock.track(page)
        await page.goto('/')
        if (!this.agreed) {
            await page.getByRole('button', { name: 'Agree' }).click()
            this.agreed = true
        }
        const tab = new Tab(page, this)
        await tab.ready()
        return tab
    }

    /** A blank same-origin page of this profile: nothing of the editor loads in it. */
    async blank() {
        const page = await this.context.newPage()
        await page.goto('/privacy/')
        return page
    }

    /** The database and localStorage, as the dumper reads them. */
    dump(version: string): Promise<Dump> {
        return dump(this.context, version)
    }

    async close() {
        await this.context.close()
    }
}

/** One open editor tab. */
export class Tab extends Editor {
    constructor(
        page: Page,
        readonly profile: Profile,
    ) {
        super(page)
    }

    get clock() {
        return this.profile.clock
    }

    rows(stores: string[]) {
        return rows(this.page, stores)
    }

    async stored(store: string) {
        return ((await this.rows([store]))[store] ?? []).map((row) => row.value)
    }

    session() {
        return sessionOf(this.page)
    }

    chain() {
        return chainOf(this.page)
    }

    chainById(chainId: unknown) {
        return chainById(this.page, chainId)
    }

    /** The open session's entry rows, in `seq` order, once everything is stored. */
    async entries() {
        await this.settled()
        const { sessionId } = await this.session()
        return (await this.stored('entries'))
            .filter((row) => row.sessionId === sessionId)
            .sort((a, b) => (a.seq as number) - (b.seq as number))
    }

    /** Every entry row of the chain the open session belongs to, in chain order. */
    async chainEntries() {
        await this.settled()
        const chain = await this.chain()
        const sessions = (await this.stored('sessions'))
            .filter((row) => row.chainId === chain.chainId)
            .sort((a, b) => (a.startedAt as number) - (b.startedAt as number))
        const entries = await this.stored('entries')
        return sessions.flatMap((session) =>
            entries
                .filter((row) => row.sessionId === session.id)
                .sort((a, b) => (a.seq as number) - (b.seq as number)),
        )
    }

    /** Presses a key in the editor and waits for the entry it makes; undefined when it makes none. */
    keyEntry(key: string) {
        return this.act(() => this.command(key))
    }

    /** Waits until everything the tab has is stored, strictly. */
    async stored_() {
        await flushed(this.page)
        await this.settled()
    }

    notice(text: string) {
        return notice(this.page).filter({ hasText: text })
    }

    /** Opens a file from this device's OPFS through the Open command's picker (Chromium's override). */
    async open(name: string) {
        await queuePicks(this.page, [name])
        await this.command('o')
    }

    pickSave(name?: string) {
        return name === undefined ? undefined : queuePicks(this.page, [name])
    }

    /** Presses Save and, in the dialog it opens, Save; `name` is the file's name without `.nxsp`. */
    async saveFirst(name: string | undefined, title?: string) {
        await pressSave(this.page)
        await submitSave(this.page, name, title)
    }

    saveDialog(title?: string) {
        return saveDialog(this.page, title)
    }

    /** The command Save As… runs, as its toolbar button and the command list run it. */
    async saveAs() {
        await this.page.evaluate(async () => {
            const { commands } = await import('/src/editor/commands/index.ts')
            const { runCommand } = await import('/src/editor/commands/runCommand.ts')
            void runCommand(commands.saveAs, 'button')
        })
    }

    /** Closes the tab as a kill does (no beforeunload), once the browser has dropped its locks. */
    kill() {
        return closePage(this.page, { runBeforeUnload: false })
    }

    /** Closes the tab as a visitor does. */
    leave() {
        return closePage(this.page, { runBeforeUnload: true })
    }
}

/** OPFS: write, read and list a profile's files as another program would. */
export const writeOpfs = (page: Page, name: string, bytes: Uint8Array) =>
    page.evaluate(
        async ({ name, base64 }) => {
            const raw = atob(base64)
            const data = new Uint8Array(raw.length)
            for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i)
            const root = await navigator.storage.getDirectory()
            const handle = await root.getFileHandle(name, { create: true })
            const writable = await handle.createWritable()
            await writable.write(data)
            await writable.close()
        },
        { name, base64: Buffer.from(bytes).toString('base64') },
    )

export const readOpfs = async (page: Page, name: string): Promise<Uint8Array> => {
    const base64 = await page.evaluate(async (name) => {
        const root = await navigator.storage.getDirectory()
        const file = await (await root.getFileHandle(name)).getFile()
        const bytes = new Uint8Array(await file.arrayBuffer())
        let binary = ''
        for (let i = 0; i < bytes.length; i += 0x8000)
            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        return btoa(binary)
    }, name)
    return new Uint8Array(Buffer.from(base64, 'base64'))
}

export { expect }

/** What this load found, as the startup events of the page name them. */
export const loadEvents = (page: Page) =>
    page.evaluate(async () => {
        const { loadEvents } = await import('/src/local/startup/events.ts')
        return loadEvents.value.map((event) => event.kind as string)
    })

/** The page as a browser hides it: the journal is written. */
export const hide = (page: Page) =>
    page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
        document.dispatchEvent(new Event('visibilitychange'))
        window.dispatchEvent(new PageTransitionEvent('pagehide'))
    })

/** The journal keys of the page's localStorage, whole. */
export const journals = (page: Page, prefix: string) =>
    page.evaluate((prefix) => {
        const found: Record<string, string> = {}
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i)
            if (key?.startsWith(`${prefix}journal.`)) found[key] = localStorage.getItem(key)!
        }
        return found
    }, prefix)

/** Holds every flush from now on (the edits that follow are the journal's alone). */
export const holdFlushes = (page: Page) =>
    page.evaluate(() => {
        window.nseFlushTest!.stall = true
    })

/** The chain the open session belongs to, by id (it may not be stored yet). */
export const openChainId = (page: Page) =>
    page.evaluate(() => window.nseFlushTest!.flusher.session?.chainId as string | undefined)

/** Open through the file input of a browser without pickers: the bytes under a name. */
export const openBytes = async (tab: Tab, name: string, bytes: Uint8Array) => {
    const chooser = tab.page.waitForEvent('filechooser')
    await tab.command('o')
    await (
        await chooser
    ).setFiles({
        name,
        mimeType: 'application/octet-stream',
        buffer: Buffer.from(bytes),
    })
}

/** Runs an action that starts a download, and returns what the browser was given. */
export const downloaded = async (tab: Tab, action: () => Promise<unknown>) => {
    const download = tab.page.waitForEvent('download')
    await action()
    const file = await download
    return {
        name: file.suggestedFilename(),
        bytes: new Uint8Array(readFileSync((await file.path())!)),
    }
}

/** This page's client id, as `navigator.locks.query()` lists it: the holder of a probe lock it takes. */
export const clientIdOf = (page: Page) =>
    page.evaluate(async () => {
        const name = `nse.test.client.${crypto.randomUUID()}`
        return navigator.locks.request(
            name,
            async () =>
                (await navigator.locks.query()).held?.find((lock) => lock.name === name)?.clientId,
        )
    })

/** Waits until the browser has dropped a closed page's Web Locks (a new load would find them held). */
export const locksReleased = async (profile: Profile, clientId: string | undefined) => {
    if (clientId === undefined) return
    const probe = await profile.context.newPage()
    try {
        await probe.goto('/privacy/')
        await expect
            .poll(
                () =>
                    probe.evaluate(
                        async (clientId) =>
                            (await navigator.locks.query()).held?.some(
                                (lock) => lock.clientId === clientId,
                            ) ?? false,
                        clientId,
                    ),
                {
                    message: 'the closed page still holds its Web Locks after 10 s',
                    timeout: 10_000,
                },
            )
            .toBe(false)
    } finally {
        await probe.close()
    }
}
