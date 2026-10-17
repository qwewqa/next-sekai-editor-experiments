import { expect, test, type Page } from '@playwright/test'
import type { StorageStatus } from '../../src/local/worker/core'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// Storing alongside today's auto save (Part 1 §1.11.3, §1.6.4): every change is an entry, and the
// flush stores the session, its chain record and the snapshots in IndexedDB.

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
    await expect.poll(() => page.evaluate(() => window.nseFlushTest !== undefined)).toBe(true)
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
                history.pushState(() => 'Added note', transaction.commit([]))
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

const storedRows = (page: Page, stores: string[]) =>
    page.evaluate(
        (stores) =>
            window.nseStorageTest!.worker.call('testRows', stores) as Promise<
                Record<string, { key: unknown; value: Record<string, unknown> }[]>
            >,
        stores,
    )

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
