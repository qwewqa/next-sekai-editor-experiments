import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { closePage, waitForStartup } from './editorFixture'
import { skipWhereTheEditorCannotStart } from './webkitSupport'

// A WebKit build without OffscreenCanvas (Playwright's on Windows) cannot start the editor.
skipWhereTheEditorCannotStart()

// Startup (Part 1 §1.4.2, §1.11.4's exit): which session a load opens. A same-tab reload keeps
// its session, decided by the session lock; a Duplicate Tab forks; a new visit continues the most
// recent session, or starts blank when it's open in another tab; a first visit starts blank. The
// recovery order runs first: the canary, the journals, the old auto save.

const prefix = 'sonolus-next-sekai-editor.'
const tabKey = `${prefix}tab`

type Row = Record<string, unknown>

/** Seeds every page of the context: the storage test hooks, and the panels out of the way. */
const seed = (context: BrowserContext, extra: Record<string, string> = {}) =>
    context.addInitScript((extra) => {
        performance.setResourceTimingBufferSize(5000)
        localStorage.setItem('nse.test.storage', '{}')
        localStorage.setItem('sonolus-next-sekai-editor.showPreview', 'false')
        localStorage.setItem('sonolus-next-sekai-editor.showSidebar', 'false')
        for (const [key, value] of Object.entries(extra)) localStorage.setItem(key, value)
    }, extra)

/** Waits until startup has opened the session this load continues. */
const opened = waitForStartup

const visit = async (page: Page) => {
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await opened(page)
}

/** A page of the context that takes over another tab's sessionStorage, as Duplicate Tab does. */
const withTabRecord = async (context: BrowserContext, record: string) => {
    const page = await context.newPage()
    await page.addInitScript(
        ({ key, record }) => {
            if (!sessionStorage.getItem('copied')) {
                sessionStorage.setItem(key, record)
                sessionStorage.setItem('copied', 'true')
            }
        },
        { key: tabKey, record },
    )
    return page
}

const tabRecord = (page: Page) =>
    page.evaluate((key) => sessionStorage.getItem(key), tabKey) as Promise<string>

const edit = (page: Page, initialLife: number) =>
    page.evaluate(async (initialLife) => {
        const { pushState, state } =
            (await import('/src/history/index.ts')) as typeof import('../../src/history')
        const { initialLife: operation } =
            (await import('/tests/helpers/historySteps.ts')) as typeof import('../helpers/historySteps')
        pushState(operation(state.value.initialLife, initialLife), { ...state.value, initialLife })
    }, initialLife)

const lifeOf = (page: Page) =>
    page.evaluate(async () => {
        const { state } =
            (await import('/src/history/index.ts')) as typeof import('../../src/history')
        return state.value.initialLife
    })

const sessionOf = (page: Page) =>
    page.evaluate(async () => {
        const { session } =
            (await import('/src/history/session.ts')) as typeof import('../../src/history/session')
        return session.value
    })

/** The flusher's open session: its ids, and its chain as the journal would describe it. */
const flushSession = (page: Page) =>
    page.evaluate(() => {
        const session = window.nseFlushTest!.flusher.session!
        const file = session.chain?.file as { name?: string; handle?: unknown } | undefined
        return {
            id: session.id,
            chainId: session.chainId,
            stored: session.stored,
            name: session.chain?.name,
            file: file
                ? { name: file.name, handle: file.handle instanceof FileSystemHandle }
                : undefined,
        }
    })

/** Waits until everything the page has is committed. */
const settled = (page: Page) =>
    expect
        .poll(() =>
            page.evaluate(() => {
                const flusher = window.nseFlushTest!.flusher
                return !flusher.hasPending && !!flusher.session?.stored
            }),
        )
        .toBe(true)

const rows = <S extends string>(page: Page, stores: S[]) =>
    page.evaluate(async (stores) => {
        const found = (await window.nseStorageTest!.worker.call('testRows', stores)) as Record<
            string,
            { value: Row }[]
        >
        return Object.fromEntries(
            Object.entries(found).map(([store, list]) => [store, list.map((row) => row.value)]),
        )
    }, stores) as Promise<Record<S, Row[]>>

const loadEvents = (page: Page) =>
    page.evaluate(async () => {
        const { loadEvents } =
            (await import('/src/local/startup/events.ts')) as typeof import('../../src/local/startup/events')
        return loadEvents.value.map((event) => event.kind)
    })

const claimOf = (page: Page) => page.evaluate(() => window.nseStartupTest?.claim)

/**
 * Binds the open session's chain to a file, as a Save would (Step 6 writes the file). Without a
 * handle: Playwright's Chromium kills a page that reads an OPFS handle back from IndexedDB.
 */
const bind = (page: Page, name: string) =>
    page.evaluate(
        (name) =>
            window.nseFlushTest!.flusher.setChainFields({
                file: {
                    name,
                    event: 'saved',
                    at: Date.now(),
                    hash: new Uint8Array(16),
                },
            }),
        name,
    )

const stallFlushes = (page: Page) =>
    page.evaluate(() => {
        window.nseFlushTest!.stall = true
    })

const hide = (page: Page) =>
    page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
    })

test.beforeEach(async ({ context }) => {
    await seed(context)
})

test('a first visit starts blank, and stores nothing without an edit', async ({ page }) => {
    await visit(page)
    expect(await claimOf(page)).toBe('none')
    expect(await loadEvents(page)).toEqual([])
    expect(await lifeOf(page)).toBe(1000)
    await page.waitForTimeout(1500)
    expect((await rows(page, ['sessions'])).sessions).toEqual([])
})

test('a same-tab reload keeps its session and its stack: no new session row', async ({ page }) => {
    await visit(page)
    await edit(page, 990)
    await edit(page, 980)
    await settled(page)
    const before = await sessionOf(page)
    page.on('dialog', (dialog) => void dialog.accept())
    await page.reload()
    await opened(page)
    expect(await claimOf(page)).toBe('reload')
    expect((await sessionOf(page)).sessionId).toBe(before.sessionId)
    expect(await lifeOf(page)).toBe(980)
    expect(await loadEvents(page)).toEqual([])
    expect((await rows(page, ['sessions'])).sessions.map((row) => row.id)).toEqual([
        before.sessionId,
    ])
    // Exactly the undo it had, the slot loading lazily.
    await page.evaluate(async () => {
        const { undoState } =
            (await import('/src/history/index.ts')) as typeof import('../../src/history')
        undoState()
    })
    await expect.poll(() => lifeOf(page)).toBe(990)
    // Its next edit appends to the same session.
    await edit(page, 970)
    await settled(page)
    const { sessions, entries } = await rows(page, ['sessions', 'entries'])
    expect(sessions).toHaveLength(1)
    expect(entries.map((entry) => entry.kind)).toEqual(['init', 'edit', 'edit', 'undo', 'edit'])
})

test('edit, kill, reload: the reload recovers its own journal in the same session, by the lock rule', async ({
    page,
    context,
}) => {
    await visit(page)
    await edit(page, 990)
    expect(await bind(page, 'kill.nxsp')).toBe(true)
    await settled(page)
    await stallFlushes(page)
    await edit(page, 960)
    // The hide's journal, then a kill: no pagehide, so no marker; the lock decides.
    await hide(page)
    await page.evaluate((key) => sessionStorage.removeItem(key), `${prefix}unloaded`)
    const record = await tabRecord(page)
    const { sessionId } = await sessionOf(page)
    const next = await withTabRecord(context, record)
    // A tab the browser discarded says so; it's only a hint, and changes nothing (§1.4.2).
    await next.addInitScript(() => {
        Object.defineProperty(document, 'wasDiscarded', { configurable: true, value: true })
    })
    await closePage(page, { runBeforeUnload: false })
    await visit(next)
    expect(await claimOf(next)).toBe('reload')
    expect((await sessionOf(next)).sessionId).toBe(sessionId)
    expect(await lifeOf(next)).toBe(960)
    // Its own reload says nothing at load.
    expect(await loadEvents(next)).toEqual([])
    const { sessions, entries } = await rows(next, ['sessions', 'entries'])
    expect(sessions.map((row) => row.id)).toEqual([sessionId])
    expect(entries.at(-1)?.kind).toBe('recovered')
    // A discard or a crash keeps the binding too: it's on the chain record.
    expect((await flushSession(next)).file).toEqual({ name: 'kill.nxsp', handle: false })
})

test('Duplicate Tab of a live tab forks into a separate copy without the binding', async ({
    page,
    context,
}) => {
    await visit(page)
    await edit(page, 990)
    expect(await bind(page, 'coconut.nxsp')).toBe(true)
    await settled(page)
    const original = await flushSession(page)
    expect(original.file).toEqual({ name: 'coconut.nxsp', handle: false })
    const duplicate = await withTabRecord(context, await tabRecord(page))
    await visit(duplicate)
    expect(await claimOf(duplicate)).toBe('duplicate')
    expect(await lifeOf(duplicate)).toBe(990)
    expect(await loadEvents(duplicate)).toEqual(['separateCopy'])
    const copy = await sessionOf(duplicate)
    expect(copy.copyOf).toEqual({ name: 'coconut.nxsp', bound: true })
    const forked = await flushSession(duplicate)
    expect(forked.id).not.toBe(original.id)
    expect(forked.chainId).not.toBe(original.chainId)
    expect(forked.file).toBeUndefined()
    expect(forked.name).toBe('coconut (2)')
    // Stored from its first edit, as a new chain copied from the old record.
    await edit(duplicate, 980)
    await settled(duplicate)
    const { chains } = await rows(duplicate, ['chains'])
    const record = chains.find((chain) => chain.chainId === forked.chainId)
    expect(record?.head).toBe(forked.id)
    expect(record?.name).toBe('coconut (2)')
    expect(record && 'file' in record).toBe(false)
    expect(chains.find((chain) => chain.chainId === original.chainId)?.head).toBe(original.id)
})

test('a new visit continues the most recent session with its binding', async ({
    page,
    context,
}) => {
    await visit(page)
    await edit(page, 990)
    expect(await bind(page, 'coconut.nxsp')).toBe(true)
    await settled(page)
    const original = await flushSession(page)
    page.on('dialog', (dialog) => void dialog.accept())
    await closePage(page, { runBeforeUnload: true })
    const next = await context.newPage()
    await visit(next)
    expect(await claimOf(next)).toBe('none')
    expect(await lifeOf(next)).toBe(990)
    expect(await loadEvents(next)).toEqual(['continued'])
    const continued = await flushSession(next)
    expect(continued.id).not.toBe(original.id)
    expect(continued.chainId).toBe(original.chainId)
    expect(continued.file).toEqual({ name: 'coconut.nxsp', handle: false })
    // A new visit adds no entry until the first edit; that edit moves the chain's head.
    await next.waitForTimeout(1500)
    expect(continued.stored).toBe(false)
    await edit(next, 980)
    await settled(next)
    const { chains, sessions } = await rows(next, ['chains', 'sessions'])
    expect(chains.find((chain) => chain.chainId === original.chainId)?.head).toBe(continued.id)
    expect(sessions.find((row) => row.id === continued.id)?.parent).toEqual({
        id: original.id,
        uptoSeq: 2,
    })
})

test('a new visit while that session is open in another tab starts blank, and Restore as a Copy forks it', async ({
    page,
    context,
}) => {
    await visit(page)
    await edit(page, 990)
    await settled(page)
    const next = await context.newPage()
    await visit(next)
    expect(await loadEvents(next)).toEqual(['openElsewhere'])
    expect(await lifeOf(next)).toBe(1000)
    const original = await flushSession(page)
    expect(
        await next.evaluate(async (sessionId) => {
            const { restoreAsCopy } =
                (await import('/src/local/startup/api.ts')) as typeof import('../../src/local/startup/api')
            return restoreAsCopy(sessionId)
        }, original.id),
    ).toEqual({ opened: true, forked: true })
    expect(await lifeOf(next)).toBe(990)
    expect((await flushSession(next)).chainId).not.toBe(original.chainId)
})

test('a reload after the session was continued in another tab during the gap forks', async ({
    page,
    context,
}) => {
    await visit(page)
    await edit(page, 990)
    await settled(page)
    const record = await tabRecord(page)
    const original = await flushSession(page)
    page.on('dialog', (dialog) => void dialog.accept())
    await closePage(page, { runBeforeUnload: true })
    // Another tab continues it meanwhile.
    const other = await context.newPage()
    await visit(other)
    await edit(other, 980)
    await settled(other)
    const reloaded = await withTabRecord(context, record)
    await visit(reloaded)
    expect(await claimOf(reloaded)).toBe('reload')
    expect(await loadEvents(reloaded)).toEqual(['separateCopy'])
    expect(await lifeOf(reloaded)).toBe(990)
    const fork = await flushSession(reloaded)
    expect(fork.id).not.toBe(original.id)
    expect(fork.chainId).not.toBe(original.chainId)
})

test('a reload after the session was deleted in another tab starts blank, with the reason', async ({
    page,
    context,
}) => {
    await visit(page)
    await edit(page, 990)
    await settled(page)
    const record = await tabRecord(page)
    const { chainId } = await flushSession(page)
    page.on('dialog', (dialog) => void dialog.accept())
    await closePage(page, { runBeforeUnload: true })
    // Delete's mark, from another tab, as Recent Sessions' Delete writes it.
    const other = await context.newPage()
    await other.goto('/privacy/')
    await other.evaluate(
        (chainId) =>
            new Promise<void>((resolve, reject) => {
                const open = indexedDB.open('nse-local-data')
                open.onsuccess = () => {
                    const tx = open.result.transaction('chains', 'readwrite')
                    const store = tx.objectStore('chains')
                    const get = store.get(chainId)
                    get.onsuccess = () => store.put({ ...get.result, deleting: { at: Date.now() } })
                    tx.oncomplete = () => {
                        open.result.close()
                        resolve()
                    }
                    tx.onerror = () => reject(tx.error ?? new Error('Not marked'))
                }
                open.onerror = () => reject(open.error ?? new Error('Not opened'))
            }),
        chainId,
    )
    await other.close()
    const reloaded = await withTabRecord(context, record)
    await visit(reloaded)
    expect(await loadEvents(reloaded)).toEqual(['deletedElsewhere'])
    expect(await lifeOf(reloaded)).toBe(1000)
})

test('an unedited New reloads as blank', async ({ page }) => {
    await visit(page)
    await edit(page, 990)
    await settled(page)
    await page.evaluate(async () => {
        const { resetState } =
            (await import('/src/history/index.ts')) as typeof import('../../src/history')
        resetState(false)
    })
    page.on('dialog', (dialog) => void dialog.accept())
    await page.reload()
    await opened(page)
    expect(await lifeOf(page)).toBe(1000)
    expect(await loadEvents(page)).toEqual([])
})

test('an unedited blank start, the session held elsewhere, continues it with its binding on reload once that tab closed', async ({
    page,
    context,
}) => {
    await visit(page)
    await edit(page, 990)
    expect(await bind(page, 'coconut.nxsp')).toBe(true)
    await settled(page)
    const next = await context.newPage()
    await visit(next)
    expect(await loadEvents(next)).toEqual(['openElsewhere'])
    page.on('dialog', (dialog) => void dialog.accept())
    await closePage(page, { runBeforeUnload: true })
    await next.reload()
    await opened(next)
    expect(await lifeOf(next)).toBe(990)
    expect(await loadEvents(next)).toEqual(['continued'])
    // The continuation carries the chain's fields, its binding included (§1.4.2).
    expect((await flushSession(next)).file).toEqual({ name: 'coconut.nxsp', handle: false })
})

test('Reopen continues the session left by New', async ({ page }) => {
    await visit(page)
    await edit(page, 990)
    await settled(page)
    const original = await flushSession(page)
    await page.evaluate(async () => {
        const { resetState } =
            (await import('/src/history/index.ts')) as typeof import('../../src/history')
        resetState(false)
    })
    expect(await lifeOf(page)).toBe(1000)
    const reopened = await page.evaluate(async () => {
        const until = async (ok: () => boolean) => {
            for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 50))
        }
        const api =
            (await import('/src/local/startup/api.ts')) as typeof import('../../src/local/startup/api')
        await until(() => api.previousSession.value !== undefined)
        return api.reopen()
    })
    expect(reopened).toBe(true)
    expect(await lifeOf(page)).toBe(990)
    expect((await flushSession(page)).chainId).toBe(original.chainId)
})

test('the marker clears when the page shows again, so a later Duplicate Tab isn’t a reload', async ({
    page,
}) => {
    await visit(page)
    await hide(page)
    const marker = () => page.evaluate((key) => sessionStorage.getItem(key), `${prefix}unloaded`)
    expect(await marker()).toBe((await sessionOf(page)).sessionId)
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
        document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(await marker()).toBeNull()
    // A page restored from the back-forward cache clears it on `pageshow` (§1.4.2).
    await page.evaluate(() => {
        window.dispatchEvent(new Event('pagehide'))
    })
    expect(await marker()).toBe((await sessionOf(page)).sessionId)
    await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    })
    expect(await marker()).toBeNull()
})

test.describe('the canary', () => {
    test('only IndexedDB cleared gives the cleared-storage event; only localStorage cleared gives none', async ({
        page,
        context,
    }) => {
        await visit(page)
        const ids = () =>
            page.evaluate((prefix) => {
                return {
                    canary: localStorage.getItem(`${prefix}canary`),
                    deviceId: localStorage.getItem(`${prefix}deviceId`),
                }
            }, prefix)
        const first = await ids()
        expect(first.canary).not.toBeNull()
        expect(first.deviceId).not.toBeNull()
        await page.goto('/privacy/')
        await page.evaluate((prefix) => {
            localStorage.removeItem(`${prefix}canary`)
            localStorage.removeItem(`${prefix}deviceId`)
        }, prefix)
        await visit(page)
        expect(await loadEvents(page)).toEqual([])
        expect(await ids()).toEqual(first)

        await page.goto('/privacy/')
        await page.evaluate(
            () =>
                new Promise<void>((resolve, reject) => {
                    const request = indexedDB.deleteDatabase('nse-local-data')
                    request.onsuccess = () => resolve()
                    request.onerror = () => reject(request.error ?? new Error('Not deleted'))
                }),
        )
        await visit(page)
        expect(await loadEvents(page)).toEqual(['storageCleared'])
        void context
    })
})

test('the migration: its session is the one a first load continues, and the old key goes', async ({
    page,
}) => {
    const levelData = { bgmOffset: 0, entities: [{ archetype: 'Initialization', data: [] }] }
    await page.goto('/privacy/')
    const stored = JSON.stringify({
        ...levelData,
        entities: [
            ...levelData.entities,
            {
                archetype: '#BPM_CHANGE',
                data: [
                    { name: '#BEAT', value: 0 },
                    { name: '#BPM', value: 150 },
                ],
            },
        ],
    })
    await page.evaluate(
        ({ prefix, stored }) => {
            localStorage.setItem(`${prefix}autoSave.levelData`, stored)
        },
        { prefix, stored },
    )
    await visit(page)
    expect(await loadEvents(page)).toEqual(['migrated'])
    const { origin } = (await rows(page, ['sessions'])).sessions[0] as { origin: string }
    expect(origin).toBe('migrated')
    expect(
        await page.evaluate(
            (prefix) => localStorage.getItem(`${prefix}autoSave.levelData`),
            prefix,
        ),
    ).toBeNull()
})

test.describe('storage unavailable', () => {
    test.beforeEach(async ({ context }) => {
        await context.addInitScript(() => {
            localStorage.setItem('nse.test.noStorage', 'true')
        })
    })

    test('edit, reload, edit: the reload continues from its own journal, which then holds both edits', async ({
        page,
    }) => {
        await visit(page)
        await edit(page, 990)
        await hide(page)
        const { sessionId } = await sessionOf(page)
        page.on('dialog', (dialog) => void dialog.accept())
        await page.reload()
        await opened(page)
        expect((await sessionOf(page)).sessionId).toBe(sessionId)
        expect(await lifeOf(page)).toBe(990)
        await page.evaluate(async () => {
            const { pushState, state } =
                (await import('/src/history/index.ts')) as typeof import('../../src/history')
            const { futureInitialLife } =
                (await import('/tests/helpers/historySteps.ts')) as typeof import('../helpers/historySteps')
            pushState(
                futureInitialLife(state.value.initialLife, state.value.initialLife, 'Title'),
                {
                    ...state.value,
                    levelInfo: { ...state.value.levelInfo, title: 'both edits' },
                },
            )
        })
        await hide(page)
        const journal = await page.evaluate(
            (key) => JSON.parse(localStorage.getItem(key)!) as { header: { levelInfo: unknown[] } },
            `${prefix}journal.${sessionId}`,
        )
        expect(journal.header.levelInfo[0]).toBe('both edits')
    })

    test('two tabs keep separate journals, and an earlier visit’s waits in Local Data', async ({
        page,
        context,
    }) => {
        await visit(page)
        await edit(page, 990)
        await hide(page)
        const second = await context.newPage()
        await visit(second)
        await edit(second, 980)
        await hide(second)
        const keys = await page.evaluate(() =>
            Object.keys(localStorage).filter((key) => key.includes('.journal.')),
        )
        expect(keys).toHaveLength(2)
        await closePage(page, { runBeforeUnload: false })
        // A later visit: offered in Local Data, never loaded.
        const later = await context.newPage()
        await visit(later)
        expect(await lifeOf(later)).toBe(1000)
        expect(await loadEvents(later)).toEqual(['unsavedInLocalData'])
        const items = await later.evaluate(async () => {
            const { recoveryItems } =
                (await import('/src/local/startup/api.ts')) as typeof import('../../src/local/startup/api')
            return (await recoveryItems()).items.map((item) => item.kind)
        })
        expect(items).toEqual(['journal'])
    })
})

test('a journal written while storage was unavailable becomes a session at a load with storage', async ({
    browser,
}) => {
    const context = await browser.newContext()
    await seed(context)
    await context.addInitScript(() => {
        if (!sessionStorage.getItem('withStorage'))
            localStorage.setItem('nse.test.noStorage', 'true')
        else localStorage.removeItem('nse.test.noStorage')
    })
    const page = await context.newPage()
    await visit(page)
    await edit(page, 990)
    await hide(page)
    await closePage(page, { runBeforeUnload: false })
    const next = await context.newPage()
    await next.addInitScript(() => {
        sessionStorage.setItem('withStorage', 'true')
        localStorage.removeItem('nse.test.noStorage')
    })
    await visit(next)
    expect(await loadEvents(next)).toEqual(['unsavedRecovered', 'continued'])
    expect(await lifeOf(next)).toBe(990)
    expect(
        await next.evaluate(() =>
            Object.keys(localStorage).filter((key) => key.includes('.journal.')),
        ),
    ).toEqual([])
    await context.close()
})

test('one load runs the recovery order: the canary, a journal, then the old auto save', async ({
    page,
    context,
}) => {
    await visit(page)
    await edit(page, 990)
    await settled(page)
    await stallFlushes(page)
    await edit(page, 980)
    await hide(page)
    await closePage(page, { runBeforeUnload: false })
    // Before the next load: another database's canary, and an old auto save from before the update.
    const other = await context.newPage()
    await other.goto('/privacy/')
    await other.evaluate((prefix) => {
        localStorage.setItem(`${prefix}canary`, JSON.stringify('another database'))
        localStorage.setItem(
            `${prefix}autoSave.levelData`,
            JSON.stringify({
                bgmOffset: 0,
                entities: [
                    { archetype: 'Initialization', data: [] },
                    {
                        archetype: '#BPM_CHANGE',
                        data: [
                            { name: '#BEAT', value: 0 },
                            { name: '#BPM', value: 150 },
                        ],
                    },
                ],
            }),
        )
    }, prefix)
    await visit(other)
    expect(await loadEvents(other)).toEqual(['storageCleared', 'journalRecovered', 'migrated'])
    // The migrated session is the newest: this load continues it.
    const { sessions } = await rows(other, ['sessions'])
    expect(sessions.map((row) => row.origin).sort()).toEqual(['migrated', 'new'])
})

/** The tab's own storage test flags for its next load (a tab's flag comes first). */
const nextLoadFlags = (page: Page, flags: Record<string, unknown>) =>
    page.evaluate((text) => {
        sessionStorage.setItem('nse.test.storage', text)
    }, JSON.stringify(flags))

const phase = (page: Page) =>
    page.evaluate(async () => {
        const { startupGate } =
            (await import('/src/startup/gate.ts')) as typeof import('../../src/startup/gate')
        return startupGate.phase
    })

const gate = (page: Page) => page.locator('dialog[data-startup-gate]')

type Seen = { seen: string[] }

test('a reload during a slow startup claims its session again: the tab record waits for the open', async ({
    page,
}) => {
    await visit(page)
    await edit(page, 990)
    await settled(page)
    const { sessionId } = await sessionOf(page)
    page.on('dialog', (dialog) => void dialog.accept())
    await nextLoadFlags(page, { holdReplayMs: 4000 })
    await page.reload()
    // Storing has started (the blank start begun), and the open hasn't come yet.
    await expect.poll(() => page.evaluate(() => window.nseFlushTest !== undefined)).toBe(true)
    expect(await phase(page)).toBe('opening')
    expect((JSON.parse(await tabRecord(page)) as Row).sessionId).toBe(sessionId)
    await page.evaluate(() => {
        sessionStorage.removeItem('nse.test.storage')
    })
    await page.reload()
    await opened(page)
    expect(await claimOf(page)).toBe('reload')
    expect((await sessionOf(page)).sessionId).toBe(sessionId)
    expect(await lifeOf(page)).toBe(990)
})

test('the gate swallows input until the real startup has opened the session', async ({ page }) => {
    await visit(page)
    await edit(page, 990)
    await settled(page)
    await page.addInitScript(() => {
        const seen: string[] = []
        ;(window as unknown as Seen).seen = seen
        document.addEventListener('keydown', (event) => seen.push(event.key))
    })
    page.on('dialog', (dialog) => void dialog.accept())
    await nextLoadFlags(page, { holdReplayMs: 2500 })
    await page.reload()
    await expect(gate(page)).toBeVisible()
    await page.keyboard.press('KeyA')
    await page.keyboard.press('KeyN')
    expect(await page.evaluate(() => (window as unknown as Seen).seen)).toEqual([])
    await opened(page)
    await expect(gate(page)).toHaveCount(0)
    expect(await lifeOf(page)).toBe(990)
    expect(await claimOf(page)).toBe('reload')
    await page.keyboard.press('KeyA')
    expect(await page.evaluate(() => (window as unknown as Seen).seen)).toEqual(['a'])
})

test('Start Blank leaves the stored session untouched, and the blank start has its own session', async ({
    page,
}) => {
    await visit(page)
    await edit(page, 990)
    await settled(page)
    const stored = await flushSession(page)
    page.on('dialog', (dialog) => void dialog.accept())
    await nextLoadFlags(page, { holdReplayMs: 3000 })
    await page.evaluate(() => {
        sessionStorage.setItem('nse.test.startup', JSON.stringify({ slowMs: 100 }))
    })
    await page.reload()
    await gate(page).getByRole('button', { name: 'Start Blank' }).click()
    await expect(gate(page)).toHaveCount(0)
    expect(await lifeOf(page)).toBe(1000)
    // Startup ends without opening it over the blank start: after the held replay, so it gets
    // the startup's own time, as waitForStartup does.
    await expect
        .poll(() => page.evaluate(() => window.nseStartupTest?.opened), { timeout: 20_000 })
        .toBe(false)
    expect(await lifeOf(page)).toBe(1000)
    await edit(page, 950)
    await settled(page)
    const blank = await flushSession(page)
    expect(blank.chainId).not.toBe(stored.chainId)
    const { chains } = await rows(page, ['chains'])
    expect(chains.find((chain) => chain.chainId === stored.chainId)?.head).toBe(stored.id)
    // Its reload takes up the blank start's session.
    await page.evaluate(() => {
        sessionStorage.removeItem('nse.test.storage')
        sessionStorage.removeItem('nse.test.startup')
    })
    await page.reload()
    await opened(page)
    expect((await flushSession(page)).id).toBe(blank.id)
    expect(await lifeOf(page)).toBe(950)
})

test('safe mode’s real startup opens blank and read-only, and writes no journal', async ({
    page,
}) => {
    await visit(page)
    await edit(page, 990)
    await settled(page)
    const stored = await flushSession(page)
    const canary = await page.evaluate((prefix) => localStorage.getItem(`${prefix}canary`), prefix)
    page.on('dialog', (dialog) => void dialog.accept())
    await page.goto('/?safe')
    await expect(page.locator('[data-safe-bar]')).toBeVisible()
    await opened(page)
    expect(await lifeOf(page)).toBe(1000)
    expect(await page.evaluate(() => window.nseFlushTest === undefined)).toBe(true)
    // What the normal page left as it went (its journal, the canary) stays as it is.
    const kept = () =>
        page.evaluate(() =>
            Object.fromEntries(
                Object.entries(localStorage).filter(([key]) => /\.(journal\.|canary)/.test(key)),
            ),
        )
    const before = await kept()
    expect(before[`${prefix}canary`]).toBe(canary)
    await edit(page, 970)
    await hide(page)
    await page.waitForTimeout(500)
    expect(await kept()).toEqual(before)
    const { sessions } = await rows(page, ['sessions'])
    expect(sessions.map((row) => row.id)).toEqual([stored.id])
})

/** A page that takes over a tab's sessionStorage with the marker: a closed tab reopened. */
const reopenedTab = async (context: BrowserContext, record: string) => {
    const page = await withTabRecord(context, record)
    await page.addInitScript(
        ({ key, sessionId }) => {
            if (!sessionStorage.getItem('marked')) {
                sessionStorage.setItem(key, sessionId)
                sessionStorage.setItem('marked', 'true')
            }
        },
        { key: `${prefix}unloaded`, sessionId: (JSON.parse(record) as Row).sessionId as string },
    )
    return page
}

test('Reopen Closed Tab: the lock coming free within the wait is a reload; held past it, a separate copy', async ({
    page,
    context,
}) => {
    await visit(page)
    await edit(page, 990)
    await settled(page)
    const record = await tabRecord(page)
    const { sessionId } = await sessionOf(page)

    // The other tab still holds it past the wait (D19): a fork.
    const copy = await reopenedTab(context, record)
    await visit(copy)
    expect(await claimOf(copy)).toBe('duplicate')
    expect(await loadEvents(copy)).toEqual(['separateCopy'])
    await copy.close({ runBeforeUnload: false })

    // It closes within the wait: a reload of the same session.
    const reopened = await reopenedTab(context, record)
    const visiting = visit(reopened)
    await reopened.waitForTimeout(500)
    await page.close({ runBeforeUnload: false })
    await visiting
    expect(await claimOf(reopened)).toBe('reload')
    expect((await sessionOf(reopened)).sessionId).toBe(sessionId)
    expect(await lifeOf(reopened)).toBe(990)
})

test('a late flush landing during the marker’s wait is in the session the reload takes up', async ({
    page,
    context,
}) => {
    await visit(page)
    await edit(page, 990)
    await settled(page)
    const record = await tabRecord(page)
    const { sessionId } = await sessionOf(page)
    await stallFlushes(page)
    await edit(page, 960)
    const reloaded = await reopenedTab(context, record)
    const visiting = visit(reloaded)
    await reloaded.waitForTimeout(300)
    // The unloading page's flush lands while the reload waits, then the page goes.
    await page.evaluate(() => {
        window.nseFlushTest!.stall = false
    })
    await settled(page)
    await page.close({ runBeforeUnload: false })
    await visiting
    expect(await claimOf(reloaded)).toBe('reload')
    expect((await sessionOf(reloaded)).sessionId).toBe(sessionId)
    expect(await lifeOf(reloaded)).toBe(960)
    const { entries } = await rows(reloaded, ['entries'])
    expect(entries.map((entry) => entry.kind)).toEqual(['init', 'edit', 'edit'])
})

test('Start Blank, edits, then a reload while startup still runs brings back the blank start’s work', async ({
    page,
}) => {
    await visit(page)
    await edit(page, 990)
    await settled(page)
    const stored = await flushSession(page)
    page.on('dialog', (dialog) => void dialog.accept())
    await nextLoadFlags(page, { holdReplayMs: 15_000 })
    await page.evaluate(() => {
        sessionStorage.setItem('nse.test.startup', JSON.stringify({ slowMs: 100 }))
    })
    await page.reload()
    await gate(page).getByRole('button', { name: 'Start Blank' }).click()
    await expect(gate(page)).toHaveCount(0)
    await edit(page, 940)
    // Startup is still holding its replay: the reload comes before it decides.
    expect(await page.evaluate(() => window.nseStartupTest)).toBeUndefined()
    await page.evaluate(() => {
        sessionStorage.removeItem('nse.test.storage')
        sessionStorage.removeItem('nse.test.startup')
    })
    await page.reload()
    await opened(page)
    expect(await lifeOf(page)).toBe(940)
    expect((await flushSession(page)).chainId).not.toBe(stored.chainId)
})

test('Start Blank’s edits while the worker hasn’t answered have a journal: a kill keeps them', async ({
    page,
    context,
}) => {
    await visit(page)
    await edit(page, 990)
    await settled(page)
    page.on('dialog', (dialog) => void dialog.accept())
    await nextLoadFlags(page, { holdStartMs: 15_000 })
    await page.evaluate(() => {
        sessionStorage.setItem('nse.test.startup', JSON.stringify({ slowMs: 100 }))
    })
    await page.reload()
    await gate(page).getByRole('button', { name: 'Start Blank' }).click()
    await expect(gate(page)).toHaveCount(0)
    await edit(page, 930)
    // The worker still hasn't answered; the hide's journal, then a kill.
    expect(await page.evaluate(() => window.nseStorageTest?.status())).toBeUndefined()
    await hide(page)
    const record = await tabRecord(page)
    const next = await withTabRecord(context, record)
    await closePage(page, { runBeforeUnload: false })
    await visit(next)
    expect(await lifeOf(next)).toBe(930)
})

// Local Data's recovery rows (Part 1 §1.4.14): a Download that cannot read its row says so and
// leaves the row, and a row gone since it was listed reads the list again.

const seedRecovered = async (page: Page) => {
    const kept = await page.evaluate(async () => {
        const kept = (await window.nseStorageTest!.worker.call('keepRecovered', {
            id: 'recovered-1',
            source: 'journal',
            from: 'journal.damaged',
            text: '{"damaged":',
            appVersion: '0.6.0',
        })) as boolean
        const { openSettings } =
            (await import('/src/editor/settings/openSettings.ts')) as typeof import('../../src/editor/settings/openSettings')
        void openSettings('localData')
        return kept
    })
    // A recovered row's bytes are a Blob, which a private-style context's IndexedDB refuses (WebKit
    // in Playwright, Safari's private windows): there is no row to act on there.
    test.skip(!kept, 'This browser’s storage refuses Blob rows, so no recovered row can be kept')
}

test('Local Data’s Download of a recovered row whose read fails shows the card and keeps the row', async ({
    page,
    context,
}) => {
    await seed(context)
    await visit(page)
    await seedRecovered(page)
    const row = page.locator('[data-recovery-row="recovered"]')
    await expect(row).toHaveCount(1)
    await page.evaluate(() => {
        const worker = window.nseStorageTest!.worker
        worker.call = new Proxy(worker.call, {
            apply(target, thisArg: unknown, args: [string, ...unknown[]]) {
                if (args[0] === 'readRecovered')
                    return Promise.reject(new Error('The storage worker stopped (spec)'))
                return Reflect.apply(target, thisArg, args) as unknown
            },
        })
    })
    let downloaded = false
    page.on('download', () => {
        downloaded = true
    })
    await row.getByRole('button', { name: 'Download' }).click()
    await expect(
        page
            .locator('.notification, .notification-pill')
            .filter({ hasText: 'The recovered work could not be downloaded.' }),
    ).toBeVisible()
    await expect(row).toHaveCount(1)
    expect(downloaded).toBe(false)
})

test('Local Data’s Download of a recovered row gone since it was listed reads the list again', async ({
    page,
    context,
}) => {
    await seed(context)
    await visit(page)
    await seedRecovered(page)
    const row = page.locator('[data-recovery-row="recovered"]')
    await expect(row).toHaveCount(1)
    // Another tab discarded it.
    await page.evaluate(() => window.nseStorageTest!.worker.call('discardRecovered', 'recovered-1'))
    await row.getByRole('button', { name: 'Download' }).click()
    await expect(row).toHaveCount(0)
})

test('a load whose binding check could not be answered says the file "may" be open elsewhere', async ({
    page,
    context,
}) => {
    await seed(context)
    await visit(page)
    await page.evaluate(async () => {
        const { addLoadEvent } =
            (await import('/src/local/startup/events.ts')) as typeof import('../../src/local/startup/events')
        addLoadEvent({
            kind: 'separateCopy',
            of: { name: 'coconut.nxsp', bound: true },
            maybe: true,
        })
    })
    await expect(
        page.locator('.notification, .notification-pill').filter({
            hasText:
                '"coconut.nxsp" may be open in another tab or window, so this is a separate copy.',
        }),
    ).toBeVisible()
})
