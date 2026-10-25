import { expect, test, type Page } from '@playwright/test'
import { waitForStartup } from './editorFixture'
import { skipWhereTheEditorCannotStart } from './webkitSupport'

// Cleanup under storage pressure: when storing pauses for a
// full browser, cached earlier media goes and storing resumes; with nothing to remove, storing
// stays paused with its signs. An earlier step whose BGM went says "BGM not loaded".

skipWhereTheEditorCannotStart()

const STORAGE_FLAGS = 'nse.test.storage'

test.beforeEach(async ({ page, browserName }) => {
    // Playwright's WebKit contexts are private: IndexedDB refuses Blobs, so no BGM is stored.
    test.skip(browserName === 'webkit', 'WebKit private contexts store no media')
    await page.addInitScript((key) => {
        // A test sets the worker's flags before a reload; the first visit has none.
        if (localStorage.getItem(key) === null) localStorage.setItem(key, '{}')
        localStorage.setItem('sonolus-next-sekai-editor.showPreview', 'false')
        localStorage.setItem('sonolus-next-sekai-editor.showSidebar', 'false')
    }, STORAGE_FLAGS)
})

const wav = (seconds: number, tone: number) => {
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
        data.writeInt16LE(Math.round(Math.sin(i / tone) * 12000), 44 + i * 2)
    return data
}

const visit = async (page: Page) => {
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await waitForStartup(page)
}

/** Reloads with these storage worker flags. */
const reloadWith = async (page: Page, flags: object) => {
    await page.evaluate(([key, text]) => localStorage.setItem(key, text), [
        STORAGE_FLAGS,
        JSON.stringify(flags),
    ] as const)
    await page.reload()
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await waitForStartup(page)
}

/** Waits until everything the page has is committed. */
const settled = (page: Page) =>
    expect
        .poll(() =>
            page.evaluate(async () => {
                const flusher = window.nseFlushTest!.flusher
                await flusher.flush()
                return !flusher.hasPending && !!flusher.session?.stored
            }),
        )
        .toBe(true)

/** Picks a file in the BGM dialog, as a user does. */
const pickBgm = async (page: Page, name: string, buffer: Buffer) => {
    await page.keyboard.press('m')
    const modal = page.getByRole('dialog')
    const field = modal.locator('input[type="button"]')
    const choosing = page.waitForEvent('filechooser')
    await field.click()
    await (await choosing).setFiles({ name, mimeType: 'audio/wav', buffer })
    await expect(field).toHaveValue(/^00:/)
    await modal.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(modal).toHaveCount(0)
    await settled(page)
}

const liveBgm = (page: Page) =>
    page.evaluate(async () => {
        const { liveState } =
            (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
        const { bgm } = liveState.value
        return { hash: bgm.meta?.hash, decoded: bgm.buffer !== undefined }
    })

const edit = (page: Page, initialLife: number) =>
    page.evaluate(async (initialLife) => {
        const { pushState, state } =
            (await import('/src/history/index.ts')) as typeof import('../../src/history')
        const { initialLife: operation } =
            (await import('/tests/helpers/historySteps.ts')) as typeof import('../helpers/historySteps')
        pushState(operation(state.value.initialLife, initialLife), { ...state.value, initialLife })
    }, initialLife)

/** The media store's hashes, read through the worker. */
const storedMedia = (page: Page) =>
    page.evaluate(async () => {
        const { toHex } =
            (await import('/src/local/hash.ts')) as typeof import('../../src/local/hash')
        const rows = (await window.nseStorageTest!.worker.call('testRows', [
            'media',
        ])) as unknown as {
            media: { key: ArrayBuffer }[]
        }
        return rows.media.map((row) => toHex(new Uint8Array(row.key))).sort()
    })

/** Moves every media row's first day of use back past GC's 2-day grace period. */
const ageMedia = (page: Page) =>
    page.evaluate(async () => {
        const { DB_NAME } =
            (await import('/src/local/db.ts')) as typeof import('../../src/local/db')
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const open = indexedDB.open(DB_NAME)
            open.onsuccess = () => resolve(open.result)
            open.onerror = () => reject(open.error)
        })
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('media', 'readwrite')
            const store = tx.objectStore('media')
            const cursor = store.openCursor()
            cursor.onsuccess = () => {
                const at = cursor.result
                if (!at) return
                const row = at.value as { day: number }
                at.update({ ...row, day: row.day - 2 })
                at.continue()
            }
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
        })
        db.close()
    })

/** The cleanup runs after storing paused full, from the app's own copy of the module. */
const fullRuns = (page: Page) =>
    page.evaluate(async () => {
        const url =
            performance
                .getEntriesByType('resource')
                .map((entry) => entry.name)
                .find((name) => new URL(name).pathname === '/src/local/pressure.ts') ??
            '/src/local/pressure.ts'
        const { pressureRuns } = (await import(url)) as typeof import('../../src/local/pressure')
        return pressureRuns.filter((run) => run.trigger === 'full')
    })

const status = (page: Page) => page.evaluate(() => window.nseStorageTest?.status())

const chip = (page: Page) => page.locator('[data-file-chip]')

const notLoaded = (page: Page) =>
    page.locator('[data-notice-card]').getByText('The BGM is not loaded.', { exact: true })

test('a full browser removes a cached earlier BGM and storing resumes; its step says the BGM is not loaded', async ({
    page,
}) => {
    await visit(page)
    await pickBgm(page, 'first.wav', wav(0.5, 5))
    const first = await liveBgm(page)
    await pickBgm(page, 'second.wav', wav(0.6, 9))
    const second = await liveBgm(page)
    await ageMedia(page)

    // Full until something is freed: the next write pauses storing, and cleanup frees the
    // first song, which only an earlier step uses.
    await reloadWith(page, { quotaUntilFreed: true })
    await edit(page, 990)
    await expect.poll(() => storedMedia(page)).toEqual([second.hash])
    await expect.poll(() => status(page)).toEqual({ mode: 'stored' })
    await settled(page)
    expect((await fullRuns(page)).some((run) => run.freed > 0)).toBe(true)
    await expect(chip(page)).toHaveCount(0)

    // Back to the first song's step: its audio is gone, and the card offers Choose Audio….
    await expect.poll(() => liveBgm(page).then((bgm) => bgm.decoded)).toBe(true)
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+z')
    await expect.poll(() => liveBgm(page)).toEqual({ hash: first.hash, decoded: false })
    await expect(notLoaded(page)).toHaveCount(1)
    await expect(
        page.locator('[data-notice-card]').getByRole('button', { name: 'Choose Audio…' }),
    ).toBeVisible()
})

test('with nothing cleanup may remove, storing stays paused with its signs and nothing is removed', async ({
    page,
}) => {
    await visit(page)
    // The first song is only in an earlier step but was stored today: within the grace period.
    await pickBgm(page, 'first.wav', wav(0.5, 5))
    await pickBgm(page, 'second.wav', wav(0.6, 9))
    const before = await storedMedia(page)
    expect(before).toHaveLength(2)

    await reloadWith(page, { forceQuota: true })
    await edit(page, 990)
    await expect.poll(() => status(page)).toEqual({ mode: 'stored', reason: 'full' })
    await expect
        .poll(() => fullRuns(page))
        .toContainEqual({ trigger: 'full', freed: 0, busy: false })
    expect(await storedMedia(page)).toEqual(before)
    await expect(chip(page)).toHaveAttribute('data-file-chip', 'notStored', { timeout: 8000 })
})
