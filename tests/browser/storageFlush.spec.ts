import { expect, test, type Page } from '@playwright/test'
import type { StorageStatus } from '../../src/local/worker/core'
import { installCanvasCounters, installEditorFixture } from './editorFixture'
import { skipWhereTheEditorCannotStart } from './webkitSupport'

// Storing alongside today's auto save: every change is an entry, and the
// flush stores the session, its chain record and the snapshots in IndexedDB.

// A WebKit build without OffscreenCanvas (Playwright's on Windows) cannot start the editor.
skipWhereTheEditorCannotStart()

const boot = async (page: Page, flags: object = {}) => {
    await page.addInitScript(installCanvasCounters)
    await page.addInitScript((text) => {
        sessionStorage.setItem('nse.test.storage', text)
    }, JSON.stringify(flags))
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await expect
        .poll(() =>
            page.evaluate(() => window.nseStorageTest?.status() as StorageStatus | undefined),
        )
        .toEqual({ mode: 'stored' })
    await expect.poll(() => page.evaluate(() => window.nseStartupTest !== undefined)).toBe(true)
}

/** Pushes n edits, each adding a note, as the note tool's history entries do. */
const addNotes = (page: Page, n: number, from = 0) =>
    page.evaluate(
        async ({ n, from }) => {
            const { history, appImport, fixtures } = window.editorTest
            void fixtures
            const { createTransaction } = await appImport<
                typeof import('../../src/state/transaction')
            >('/src/state/transaction.ts')
            const { addNote } = await appImport<
                typeof import('../../src/state/mutations/slides/note')
            >('/src/state/mutations/slides/note.ts')
            const { createSlideId } = await appImport<
                typeof import('../../src/state/entities/slides')
            >('/src/state/entities/slides/index.ts')
            for (let i = 0; i < n; i++) {
                const transaction = createTransaction(history.liveState.value)
                addNote(transaction, createSlideId(), {
                    groupId: 1,
                    stageId: 1,
                    beat: 8 + from + i,
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
                } as never)
                history.pushState(window.editorTest.historySteps.noteAdd(1), transaction.commit([]))
            }
        },
        { n, from },
    )

const settled = (page: Page) =>
    expect
        .poll(() =>
            page.evaluate(async () => {
                const test = window.nseFlushTest!
                await test.flusher.flush()
                return !test.flusher.hasPending
            }),
        )
        .toBe(true)

type Row = { key: unknown; value: Record<string, unknown> }

const storedRows = <S extends string>(page: Page, stores: S[]) =>
    page.evaluate(
        (stores) =>
            window.nseStorageTest!.worker.call('testRows', stores) as Promise<
                Record<string, Row[]>
            >,
        stores,
    ) as Promise<Record<S, Row[]>>

test('edits are stored: the session, its chain record and an entry per change', async ({
    page,
}) => {
    await boot(page)
    await addNotes(page, 3)
    await settled(page)
    const rows = await storedRows(page, ['sessions', 'chains', 'entries', 'meta'])
    expect(rows.sessions).toHaveLength(1)
    expect(rows.chains).toHaveLength(1)
    const [session] = rows.sessions
    const [chain] = rows.chains
    expect(chain!.value.head).toBe(session!.value.id)
    expect(chain!.value.edited).toBe(true)
    expect(rows.entries.map(({ value }) => value.kind)).toEqual(['init', 'edit', 'edit', 'edit'])
    const descriptor = await page.evaluate(() =>
        window.editorTest
            .appImport<typeof import('../../src/history/session')>('/src/history/session.ts')
            .then(({ session }) => session.value),
    )
    expect(session!.value.id).toBe(descriptor.sessionId)
    expect(chain!.value.docId).toBe(descriptor.docId)
    const meta = Object.fromEntries(rows.meta.map(({ value }) => [value.key, value.value]))
    expect(meta.daysOfUse).toBe(1)
    expect(await page.evaluate(() => window.nseFlushTest!.errors)).toEqual([])
})

test('undo and redo are entries pointing at existing snapshots', async ({ page }) => {
    await boot(page)
    await addNotes(page, 2)
    await page.evaluate(() => {
        window.editorTest.history.undoState()
        window.editorTest.history.redoState()
    })
    await settled(page)
    const { entries } = await storedRows(page, ['entries'])
    expect(entries.map(({ value }) => value.kind)).toEqual(['init', 'edit', 'edit', 'undo', 'redo'])
    const hex = (bytes: unknown) => [...(bytes as Uint8Array)].map((b) => b.toString(16)).join()
    expect(hex(entries[3]!.value.snapshot)).toBe(hex(entries[1]!.value.snapshot))
    expect(hex(entries[4]!.value.snapshot)).toBe(hex(entries[2]!.value.snapshot))
})

test('the dev console reads a stored snapshot with field names', async ({ page }) => {
    await boot(page)
    await addNotes(page, 1)
    await settled(page)
    const { entries } = await storedRows(page, ['entries'])
    const hex = [...(entries.at(-1)!.value.snapshot as Uint8Array)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    const inspected = (await page.evaluate((hex) => window.nse!.inspectSnapshot(hex), hex)) as {
        root: { noteCount: number }
        kinds: { name: string }[]
    }
    expect(inspected.root.noteCount).toBeGreaterThan(0)
    expect(inspected.kinds.map(({ name }) => name)).toContain('slides')
})

test('a worker killed mid-flush keeps the session lock on the page, and the restarted worker gets the pending entries', async ({
    page,
    context,
}) => {
    await boot(page, { crashAt: 'flush:beforeCommit' })
    await addNotes(page, 1)
    await settled(page)
    const sessionId = await page.evaluate(() => window.nseFlushTest!.flusher.session!.id)
    // The next flush's transaction kills the worker after it received the batch, before commit.
    await page.evaluate(() =>
        window.nseStorageTest!.worker.call('testArmCrash', 'flush:beforeCommit'),
    )
    await addNotes(page, 2, 10)
    const flushed = page.evaluate(() => window.nseFlushTest!.flusher.flush())
    await expect
        .poll(() => page.evaluate(() => window.nseStorageTest!.worker.started.length))
        .toBe(2)
    // The lock is the page's, so the kill took none with it: another tab can't take it.
    const lockName = `nse-session:${sessionId}`
    const held = await page.evaluate(async (name) => {
        const { held } = await navigator.locks.query()
        return (held ?? []).some((lock) => lock.name === name)
    }, lockName)
    expect(held).toBe(true)
    const other = await context.newPage()
    await other.goto('/')
    const taken = await other.evaluate(
        (name) => navigator.locks.request(name, { ifAvailable: true }, (lock) => lock !== null),
        lockName,
    )
    expect(taken).toBe(false)
    await other.close()
    await flushed
    await settled(page)
    const { entries } = await storedRows(page, ['entries'])
    expect(entries.map(({ value }) => value.kind)).toEqual(['init', 'edit', 'edit', 'edit'])
    expect(entries.map(({ value }) => value.seq)).toEqual([1, 2, 3, 4])
})

const wav = (seconds: number) => {
    const sampleRate = 8000
    const length = Math.round(seconds * sampleRate)
    const data = Buffer.alloc(44 + length * 2)
    data.write('RIFF', 0)
    data.writeUInt32LE(data.length - 8, 4)
    data.write('WAVEfmt ', 8)
    data.writeUInt32LE(16, 16)
    data.writeUInt16LE(1, 20)
    data.writeUInt16LE(1, 22)
    data.writeUInt32LE(sampleRate, 24)
    data.writeUInt32LE(sampleRate * 2, 28)
    data.writeUInt16LE(2, 32)
    data.writeUInt16LE(16, 34)
    data.write('data', 36)
    data.writeUInt32LE(length * 2, 40)
    for (let i = 0; i < length; i++)
        data.writeInt16LE(Math.round(Math.sin(i / 5) * 12000), 44 + i * 2)
    return data
}

test('a picked BGM is stored with its change, read back whole, and named in the state', async ({
    page,
    browserName,
}) => {
    await boot(page)
    const file = wav(0.5)
    await page.keyboard.press('m')
    const modal = page.getByRole('dialog')
    const field = modal.locator('input[type="button"]')
    const choosing = page.waitForEvent('filechooser')
    await field.click()
    await (await choosing).setFiles({ name: 'pick.wav', mimeType: 'audio/wav', buffer: file })
    await expect(field).toHaveValue(/^00:/)
    await modal.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(modal).toHaveCount(0)
    // The pick flushes at once.
    await expect
        .poll(() => page.evaluate(() => window.nseFlushTest!.reports.at(-1)?.strict))
        .toBe(true)
    await settled(page)

    const meta = await page.evaluate(() => window.editorTest.history.liveState.value.bgm.meta)
    expect(meta).toMatchObject({ filename: 'pick.wav', size: file.length, type: 'audio/wav' })
    expect(meta!.durationMs).toBe(500)
    // The source is a copy that survived decoding.
    expect(
        await page.evaluate(() => window.editorTest.history.liveState.value.bgm.source?.byteLength),
    ).toBe(file.length)
    // Playwright's WebKit contexts are private, as Safari's private windows: IndexedDB refuses
    // Blobs there, so the change is stored and the BGM is left pending.
    if (browserName === 'webkit') {
        expect((await storedRows(page, ['entries', 'media'])).media).toHaveLength(0)
        expect(
            await page.evaluate(
                () => (window.nseStorageTest!.status() as StorageStatus).mediaPending,
            ),
        ).toEqual([meta!.hash])
        return
    }
    const stored = await page.evaluate(async (hash) => {
        const { media } = (await window.nseStorageTest!.worker.call('testRows', [
            'media',
        ])) as unknown as {
            media: {
                value: { blob: Blob; sha256: Uint8Array; size: number; type: string; kind: string }
            }[]
        }
        const [row] = media
        const bytes = new Uint8Array(await row!.value.blob.arrayBuffer())
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
        const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
        return {
            count: media.length,
            size: row!.value.size,
            type: row!.value.type,
            kind: row!.value.kind,
            matches: hex(digest) === hex(row!.value.sha256) && hex(digest).startsWith(hash),
        }
    }, meta!.hash)
    expect(stored).toEqual({
        count: 1,
        size: file.length,
        type: 'audio/wav',
        kind: 'bgm',
        matches: true,
    })
})

test('a flush that fails is recorded in the diagnostics ring, once however often it retries', async ({
    page,
}) => {
    // Forced full from the start: storing is paused before the first edit.
    await page.addInitScript(installCanvasCounters)
    await page.addInitScript(() => {
        sessionStorage.setItem('nse.test.storage', JSON.stringify({ forceQuota: true }))
    })
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await expect.poll(() => page.evaluate(() => window.nseStartupTest !== undefined)).toBe(true)
    await addNotes(page, 1)
    const texts = () =>
        page.evaluate(async () => {
            const { ringEntries } =
                await window.editorTest.appImport<typeof import('../../src/diagnostics')>(
                    '/src/diagnostics.ts',
                )
            return ringEntries().map(({ kind, text }) => `${kind}: ${text}`)
        })
    await expect.poll(texts).toContainEqual(expect.stringMatching(/^error: .*paused/i))
    // More edits fail the same way: the ring keeps the one entry.
    await addNotes(page, 2, 1)
    await expect
        .poll(async () => (await texts()).filter((text) => /paused/i.test(text)).length)
        .toBe(1)
})
