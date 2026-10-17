import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StorageStatus } from '../../src/local/worker/core'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// The journal kill tests (Part 1 §1.6.4 #7, Step 3b's exit): edits that only the journal holds
// (flushes held, as a kill leaves them), then the tab killed, then a new visit whose
// `startupApplyJournals` applies the journal to the session in IndexedDB. What each browser's
// kill exercises (§1.11's test notes): Chromium page.close() and CDP Page.crash after a hidden
// visibilitychange; Firefox and WebKit page.close() only.

test.skip(
    ({ browserName }) => browserName === 'webkit' && process.platform === 'win32',
    'Playwright WebKit on Windows does not provide Web Audio',
)

type Row = { key: unknown; value: Record<string, unknown> }

const boot = async (page: Page) => {
    await page.addInitScript(installCanvasCounters)
    await page.addInitScript(() => {
        sessionStorage.setItem('nse.test.storage', '{}')
    })
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await expect
        .poll(
            () => page.evaluate(() => window.nseStorageTest?.status() as StorageStatus | undefined),
            { timeout: 20_000 },
        )
        .toEqual({ mode: 'stored' })
    await expect
        .poll(() => page.evaluate(() => window.nseFlushTest !== undefined), { timeout: 20_000 })
        .toBe(true)
}

/** Starts the default blank chart, whose values all survive level data. */
const startBlank = (page: Page) =>
    page.evaluate(() => {
        window.editorTest.history.resetState(false)
    })

/** Edits through the app's own modules, as its tools do. */
const edit = (page: Page, kind: 'notes' | 'wholeChart' | 'bgm' | 'third' | 'guides', n = 1) =>
    page.evaluate(
        async ({ kind, n }) => {
            const { history, appImport } = window.editorTest
            const { createTransaction } = await appImport<
                typeof import('../../src/state/transaction')
            >('/src/state/transaction.ts')
            const { addNote, replaceNote } = await appImport<
                typeof import('../../src/state/mutations/slides/note')
            >('/src/state/mutations/slides/note.ts')
            const { createSlideId } = await appImport<
                typeof import('../../src/state/entities/slides')
            >('/src/state/entities/slides/index.ts')
            const live = () => history.liveState.value
            const note = (beat: number, extra: object = {}) =>
                ({
                    groupId: [...live().groups.keys()][0],
                    stageId: [...live().stages.keys()][0],
                    beat,
                    noteType: 'default',
                    isAttached: false,
                    left: -2,
                    size: 2,
                    isCritical: false,
                    flickDirection: 'none',
                    isFake: false,
                    noteStyle: 'default',
                    connectorStyle: 'default',
                    sfx: 'default',
                    isConnectorSeparator: false,
                    connectorType: 'active',
                    connectorEase: 'linear',
                    connectorIsFake: false,
                    connectorActiveIsCritical: false,
                    connectorGuideAlpha: 1,
                    connectorLayer: 'top',
                    connectorIsPassThrough: false,
                    connectorPresentation: 'default',
                    elevation: 0,
                    ...extra,
                }) as never
            const notes = () => [...live().store.slides.note.values()].flat()
            if (kind === 'notes')
                for (let i = 0; i < n; i++) {
                    const transaction = createTransaction(live())
                    addNote(transaction, createSlideId(), note(8 + notes().length))
                    history.pushState(() => 'Added note', transaction.commit([]))
                }
            if (kind === 'wholeChart') {
                const transaction = createTransaction(live())
                for (const each of notes())
                    replaceNote(transaction, each, { ...each, beat: each.beat + 1 })
                history.pushState(() => 'Moved notes', transaction.commit([]))
            }
            if (kind === 'third') {
                const transaction = createTransaction(live())
                addNote(transaction, createSlideId(), note(4, { left: 1 / 3 }))
                history.pushState(() => 'Added note', transaction.commit([]))
            }
            if (kind === 'guides')
                // Two guides, the default-coloured one created second and earlier in beat.
                for (const [beat, connectorStyle] of [
                    [40, 'red'],
                    [38, 'default'],
                ] as const) {
                    const transaction = createTransaction(live())
                    const slideId = createSlideId()
                    for (const at of [beat, beat + 1])
                        addNote(
                            transaction,
                            slideId,
                            note(at, { connectorType: 'guide', connectorStyle }),
                        )
                    history.pushState(() => 'Added guide', transaction.commit([]))
                }
            if (kind === 'bgm') {
                const meta = {
                    hash: 'ab'.repeat(16),
                    filename: 'song.mp3',
                    size: 1234,
                    type: 'audio/mpeg',
                }
                history.pushState(() => 'Changed BGM', {
                    ...live(),
                    bgm: { ...live().bgm, filename: 'song.mp3', meta },
                })
            }
        },
        { kind, n },
    )

/** Flushes and waits until nothing is pending. */
const settled = (page: Page) =>
    expect
        .poll(() =>
            page.evaluate(async () => {
                const test = window.nseFlushTest!
                await test.flusher.flush({ strict: true })
                return !test.flusher.hasPending
            }),
        )
        .toBe(true)

/** What the live state hashes to, and its session. */
const head = (page: Page) =>
    page.evaluate(async () => {
        const { history, appImport } = window.editorTest
        const records = await appImport<typeof import('../../src/local/records/records')>(
            '/src/local/records/records.ts',
        )
        const snapshot = await appImport<typeof import('../../src/local/records/snapshot')>(
            '/src/local/records/snapshot.ts',
        )
        const { toHex } =
            await appImport<typeof import('../../src/local/hash')>('/src/local/hash.ts')
        const { session } =
            await appImport<typeof import('../../src/history/session')>('/src/history/session.ts')
        const state = history.liveState.value
        return {
            root: toHex(snapshot.encodeSnapshot(records.toRecords(state)).root.hash),
            sessionId: session.value.sessionId,
            groups: [...state.groups.keys()],
            stages: [...state.stages.keys()],
        }
    })

/** Holds every flush from now on, so the edits that follow are the journal's alone. */
const holdFlushes = (page: Page) =>
    page.evaluate(() => {
        window.nseFlushTest!.stall = true
    })

/** A new visit: a fresh tab of the same profile, whose load replays the journals. */
const newVisit = async (profile: Profile | BrowserContext) => {
    const page = await ('open' in profile ? profile.open() : profile.newPage())
    await boot(page)
    await expect.poll(() => page.evaluate(() => window.nseJournalTest !== undefined)).toBe(true)
    return page
}

const rowsOf = (page: Page, stores: string[]) =>
    page.evaluate(
        (stores) =>
            window.nseStorageTest!.worker.call('testRows', stores) as Promise<
                Record<string, Row[]>
            >,
        stores,
    )

const hex = (bytes: unknown) =>
    [...new Uint8Array(bytes as ArrayLike<number>)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')

/** The recovered entry of a session, after the replay at load. */
const recovered = async (page: Page, sessionId: string) => {
    const outcomes = await page.evaluate(() => window.nseJournalTest!.outcomes.map((o) => o.kind))
    expect(outcomes).toContain('applied')
    const rows = await rowsOf(page, ['entries', 'sessions'])
    const entries = rows.entries!.map(({ value }) => value).filter((e) => e.sessionId === sessionId)
    const last = entries.at(-1)!
    expect(last.kind).toBe('recovered')
    return { entry: last, entries }
}

/** The ids a stored root's header names. */
const headerIds = (page: Page, root: string) =>
    page.evaluate(async (root) => {
        const parts = await window.nseStorageTest!.worker.call('readSnapshot', root)
        const header = (parts.chunks as Record<string, unknown[]>)[(parts.root as string[])[1]!]!
        const ids = (list: unknown) => (list as unknown[][]).map((item) => item[0])
        return { groups: ids(header[3]), stages: ids(header[4]) }
    }, root)

const killByClose = async (page: Page) => {
    await page.close()
}

/** Chromium's mobile kill: the journal written on hidden, then the renderer gone. */
const killByCrash = async (page: Page) => {
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
        document.dispatchEvent(new Event('visibilitychange'))
    })
    const cdp = await page.context().newCDPSession(page)
    const crashed = page.waitForEvent('crash')
    // The call never answers: the renderer is gone.
    void cdp.send('Page.crash').catch(() => undefined)
    await crashed
}

/** Where a test's tabs live: a kill, then the profile as a new visit finds it. */
type Profile = { open: () => Promise<Page>; afterKill: () => Promise<void> }

/** The test's own context: page.close() leaves the profile as it was. */
const shared = (context: BrowserContext): Profile => ({
    open: () => context.newPage(),
    afterKill: () => Promise.resolve(),
})

/**
 * A profile on disk: a renderer crash takes the context down with it, so the next visit is the
 * browser started again over the same profile.
 */
const onDisk = async (
    launch: (dir: string) => Promise<BrowserContext>,
): Promise<Profile & { close: () => Promise<void> }> => {
    const dir = await mkdtemp(join(tmpdir(), 'nse-journal-'))
    let context = await launch(dir)
    return {
        open: () => context.newPage(),
        afterKill: async () => {
            await context.close().catch(() => undefined)
            context = await launch(dir)
        },
        close: async () => {
            await context.close().catch(() => undefined)
            // Windows can hold the closed browser's files a moment longer.
            await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
                () => undefined,
            )
        },
    }
}

const kinds = [
    ['wholeChart', 'whole-chart'],
    ['notes', 'normal'],
    ['bgm', 'BGM'],
] as const

/** Edits flushed, then edits only the journal holds, then the kill, then a new visit. */
const killAndRecover = async (
    profile: Profile,
    kind: (typeof kinds)[number][0],
    kill: (page: Page) => Promise<void>,
) => {
    const page = await profile.open()
    await boot(page)
    await startBlank(page)
    await edit(page, 'notes', 30)
    await settled(page)
    await holdFlushes(page)
    if (kind !== 'notes') await edit(page, 'notes', 2)
    await edit(page, kind)
    const expected = await head(page)
    await kill(page)
    await profile.afterKill()

    const next = await newVisit(profile)
    const { entry } = await recovered(next, expected.sessionId)
    // Values that survive level data: the recovered state hashes as the flushed one would.
    expect(hex(entry.snapshot)).toBe(expected.root)
    // The key went once the journal was applied.
    const keys = await next.evaluate(() =>
        Object.keys(localStorage).filter((key) => key.includes('.journal.')),
    )
    expect(keys).toEqual([])
}

for (const [kind, name] of kinds) {
    test(`after a ${name} edit, page.close() leaves a journal a new visit applies`, async ({
        context,
    }) => {
        await killAndRecover(shared(context), kind, killByClose)
    })

    test(`after a ${name} edit, a crash after hidden leaves a journal a new visit applies`, async ({
        playwright,
        browserName,
    }, testInfo) => {
        test.skip(browserName !== 'chromium', 'CDP Page.crash is Chromium’s')
        // Two browser starts over one profile on disk.
        test.setTimeout(120_000)
        const { baseURL } = testInfo.project.use
        const profile = await onDisk((dir) =>
            playwright.chromium.launchPersistentContext(dir, { ...(baseURL ? { baseURL } : {}) }),
        )
        try {
            await killAndRecover(profile, kind, killByCrash)
        } finally {
            await profile.close()
        }
    })
}

test('a chart at lane division 3 recovers with its ids and a different root', async ({
    context,
}) => {
    const page = await context.newPage()
    await boot(page)
    await startBlank(page)
    await edit(page, 'notes', 3)
    await settled(page)
    await holdFlushes(page)
    await edit(page, 'third')
    const expected = await head(page)
    await killByClose(page)
    const next = await newVisit(context)
    const { entry } = await recovered(next, expected.sessionId)
    const root = hex(entry.snapshot)
    expect(root).not.toBe(expected.root)
    expect(await headerIds(next, root)).toEqual({
        groups: expected.groups,
        stages: expected.stages,
    })
})

test('two guides, the default-coloured one created second and earlier, recover with their colours', async ({
    context,
}) => {
    const page = await context.newPage()
    await boot(page)
    await startBlank(page)
    await edit(page, 'notes', 3)
    await settled(page)
    await holdFlushes(page)
    await edit(page, 'guides')
    const expected = await head(page)
    await killByClose(page)
    const next = await newVisit(context)
    const { entry } = await recovered(next, expected.sessionId)
    expect(hex(entry.snapshot)).toBe(expected.root)
})

test('a second hide for the same seq writes nothing, and the key goes only after a strict commit', async ({
    page,
}) => {
    await boot(page)
    await edit(page, 'notes', 2)
    await settled(page)
    await holdFlushes(page)
    await edit(page, 'notes')
    const hide = () =>
        page.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', {
                value: 'hidden',
                configurable: true,
            })
            document.dispatchEvent(new Event('visibilitychange'))
            window.dispatchEvent(new PageTransitionEvent('pagehide'))
        })
    await hide()
    await hide()
    const writes = () => page.evaluate(() => window.nseFlushTest!.journal.writes.length)
    expect(await writes()).toBe(1)
    const journalKeys = () =>
        page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes('.journal.')))
    expect(await journalKeys()).toHaveLength(1)
    await page.evaluate(() => {
        window.nseFlushTest!.stall = false
    })
    await settled(page)
    expect(await journalKeys()).toEqual([])
})

test('with localStorage full the journal does not verify, and the session is not durably stored', async ({
    page,
}) => {
    await boot(page)
    await edit(page, 'notes', 2)
    await settled(page)
    expect(await page.evaluate(() => window.nseFlushTest!.isDurablyStored())).toBe(true)
    await holdFlushes(page)
    await page.evaluate(() => {
        // Fill what's left of localStorage.
        let chunk = 'x'.repeat(1 << 20)
        for (let i = 0; chunk.length > 16; i++)
            try {
                localStorage.setItem(`fill.${i}`, chunk)
            } catch {
                chunk = chunk.slice(chunk.length / 2)
            }
    })
    await edit(page, 'notes')
    expect(await page.evaluate(() => window.nseFlushTest!.isDurablyStored())).toBe(false)
    await page.evaluate(() => {
        for (const key of Object.keys(localStorage))
            if (key.startsWith('fill.')) localStorage.removeItem(key)
    })
})
