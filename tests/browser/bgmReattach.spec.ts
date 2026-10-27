import { expect, test, type Page } from '@playwright/test'
import { installTestPlatform, waitForStartup } from './editorFixture'
import { pressSave, submitSave } from './saveFlows'
import { skipWhereTheEditorCannotStart } from './webkitSupport'

// Media re-attach: a session whose BGM is in the media store
// plays after a reload, and "not loaded" is said only for a BGM neither memory nor the store holds.

// A WebKit build without OffscreenCanvas (Playwright's on Windows) cannot start the editor.
skipWhereTheEditorCannotStart()

const wav = (seconds: number, tone = 5) => {
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

/** The storage hooks and a quiet layout in every page of the test, surviving reloads. */
test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('nse.test.storage', '{}')
        // A reload on a slow runner can outlast the 12 s a load notice may join the start-up notice.
        localStorage.setItem('nse.test.startupWindow', '600000')
        localStorage.setItem('sonolus-next-sekai-editor.showPreview', 'false')
        localStorage.setItem('sonolus-next-sekai-editor.showSidebar', 'false')
    })
})

const visit = async (page: Page) => {
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await waitForStartup(page)
}

const reload = async (page: Page) => {
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

/** The live BGM as the page holds it. */
const liveBgm = (page: Page) =>
    page.evaluate(async () => {
        const { liveState } =
            (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
        const { bgm } = liveState.value
        return {
            hash: bgm.meta?.hash,
            filename: bgm.meta?.filename,
            decoded: bgm.buffer !== undefined,
            bytes: bgm.source?.byteLength,
            offset: bgm.offset,
        }
    })

const loadEventKinds = (page: Page) =>
    page.evaluate(async () => {
        const { loadEvents } =
            (await import('/src/local/startup/events.ts')) as typeof import('../../src/local/startup/events')
        return loadEvents.value.map((event) => event.kind)
    })

test.describe('a reload', () => {
    // Playwright's WebKit contexts are private, as Safari's private windows: IndexedDB refuses
    // Blobs there, so no BGM is ever stored and "not loaded" is true after a reload.
    test.beforeEach(({ browserName }) => {
        test.skip(browserName === 'webkit', 'WebKit private contexts store no media')
    })

    test('plays the BGM the media store holds and does not say it is not loaded', async ({
        page,
    }) => {
        await visit(page)
        const file = wav(0.5)
        await pickBgm(page, 'pick.wav', file)
        const picked = await liveBgm(page)
        expect(picked).toMatchObject({ filename: 'pick.wav', decoded: true, bytes: file.length })

        await reload(page)
        // Silent before: the state named the audio, and nothing brought it back.
        await expect.poll(() => liveBgm(page).then((bgm) => bgm.decoded)).toBe(true)
        expect(await liveBgm(page)).toEqual(picked)
        expect(await loadEventKinds(page)).not.toContain('bgmNotLoaded')
        await expect(page.getByText('The BGM is not loaded.', { exact: true })).toHaveCount(0)
    })
})

/** Removes a BGM's row from the media store, as cleanup in another tab does. */
const dropMedia = (page: Page, hash: string) =>
    page.evaluate(async (hash) => {
        const { DB_NAME, hashKey } =
            (await import('/src/local/db.ts')) as typeof import('../../src/local/db')
        const { fromHex16 } =
            (await import('/src/local/hash.ts')) as typeof import('../../src/local/hash')
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const open = indexedDB.open(DB_NAME)
            open.onsuccess = () => resolve(open.result)
            open.onerror = () => reject(open.error)
        })
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('media', 'readwrite')
            tx.objectStore('media').delete(hashKey(fromHex16(hash)))
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
        })
        db.close()
    }, hash)

const storedCount = (page: Page, store: 'entries' | 'media') =>
    page.evaluate(
        async (store) =>
            (
                (await window.nseStorageTest!.worker.call('testRows', [
                    store,
                ])) as unknown as Record<string, unknown[]>
            )[store]!.length,
        store,
    )

const notLoaded = (page: Page) =>
    page.locator('[data-notice-card]').getByText('The BGM is not loaded.', { exact: true })

const chooseAudio = async (page: Page, name: string, buffer: Buffer) => {
    const choosing = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Choose Audio…' }).click()
    await (await choosing).setFiles({ name, mimeType: 'audio/wav', buffer })
    await expect(page.getByRole('dialog')).toHaveCount(0)
}

const undo = async (page: Page) => {
    await page.keyboard.press('Control+z')
}

test.describe('with a stored BGM', () => {
    test.beforeEach(({ browserName }) => {
        test.skip(browserName === 'webkit', 'WebKit private contexts store no media')
    })

    test('Undo across a BGM change after a reload attaches the other song from the store', async ({
        page,
    }) => {
        await visit(page)
        await pickBgm(page, 'first.wav', wav(0.5, 5))
        const first = await liveBgm(page)
        await pickBgm(page, 'second.wav', wav(0.6, 9))
        const second = await liveBgm(page)
        expect(second.hash).not.toBe(first.hash)

        await reload(page)
        await expect.poll(() => liveBgm(page).then((bgm) => bgm.decoded)).toBe(true)
        expect(await liveBgm(page)).toEqual(second)
        await undo(page)
        // The slot has the first song's name only; the media store brings its audio back.
        await expect
            .poll(() => liveBgm(page))
            .toEqual(expect.objectContaining({ hash: first.hash, decoded: true }))
        // Redo lands on the second song with its audio, from memory this time.
        await page.keyboard.press('Control+y')
        await expect
            .poll(() => liveBgm(page))
            .toEqual(expect.objectContaining({ hash: second.hash, decoded: true }))
        await expect(notLoaded(page)).toHaveCount(0)
    })

    test('a BGM the store lost is said once when Undo reaches it, and Redo and Undo do not repeat it', async ({
        page,
    }) => {
        await visit(page)
        await pickBgm(page, 'first.wav', wav(0.5, 5))
        const first = await liveBgm(page)
        await pickBgm(page, 'second.wav', wav(0.6, 9))
        await dropMedia(page, first.hash!)
        await reload(page)
        await expect.poll(() => liveBgm(page).then((bgm) => bgm.decoded)).toBe(true)
        // Loading says nothing: the BGM the session shows is held.
        await expect(notLoaded(page)).toHaveCount(0)

        await undo(page)
        await expect(notLoaded(page)).toHaveCount(1)
        expect(await liveBgm(page)).toMatchObject({ hash: first.hash, decoded: false })
        await page.getByRole('button', { name: 'Close' }).click()
        await expect(notLoaded(page)).toHaveCount(0)
        await page.keyboard.press('Control+y')
        await expect.poll(() => liveBgm(page).then((bgm) => bgm.hash)).not.toBe(first.hash)
        await page.keyboard.press('Control+z')
        await expect.poll(() => liveBgm(page).then((bgm) => bgm.hash)).toBe(first.hash)
        await expect(notLoaded(page)).toHaveCount(0)
    })

    test('Choose Audio… with the same file brings the audio back as no entry, and it survives a reload', async ({
        page,
    }) => {
        await visit(page)
        const file = wav(0.5)
        await pickBgm(page, 'pick.wav', file)
        const picked = await liveBgm(page)
        await dropMedia(page, picked.hash!)
        await reload(page)
        await expect(page.getByText('The BGM is not loaded.', { exact: true })).toBeVisible()
        expect(await liveBgm(page)).toMatchObject({ hash: picked.hash, decoded: false })
        const entries = await storedCount(page, 'entries')
        expect(await storedCount(page, 'media')).toBe(0)

        await chooseAudio(page, 'renamed.wav', file)
        // The line that offered it is gone with the card, since it is no longer true.
        await expect(page.getByText('The BGM is not loaded.', { exact: true })).toHaveCount(0)
        // The recorded name stays; the audio is there, and no step was made.
        await expect.poll(() => liveBgm(page)).toEqual(picked)
        await expect.poll(() => storedCount(page, 'media')).toBe(1)
        expect(await storedCount(page, 'entries')).toBe(entries)
        await settled(page)

        await reload(page)
        await expect.poll(() => liveBgm(page).then((bgm) => bgm.decoded)).toBe(true)
        expect(await liveBgm(page)).toEqual(picked)
        await expect(page.getByText('The BGM is not loaded.', { exact: true })).toHaveCount(0)
    })

    test('the BGM dialog with the same file attaches it as Choose Audio… does; an offset with it is one step', async ({
        page,
    }) => {
        await visit(page)
        const file = wav(0.5)
        await pickBgm(page, 'pick.wav', file)
        const picked = await liveBgm(page)
        await dropMedia(page, picked.hash!)
        await reload(page)
        await expect(page.getByText('The BGM is not loaded.', { exact: true })).toBeVisible()
        const entries = await storedCount(page, 'entries')

        // Picked where the dialog says "BGM not loaded": no "Changed BGM" step from it to itself.
        await pickBgm(page, 'renamed.wav', file)
        await expect.poll(() => liveBgm(page)).toEqual(picked)
        await expect.poll(() => storedCount(page, 'media')).toBe(1)
        expect(await storedCount(page, 'entries')).toBe(entries)

        // Lost again, then picked with a new offset: the offset is the one step.
        await dropMedia(page, picked.hash!)
        await reload(page)
        await expect(page.getByText('The BGM is not loaded.', { exact: true })).toBeVisible()
        const before = await storedCount(page, 'entries')
        await page.keyboard.press('m')
        const modal = page.getByRole('dialog')
        const field = modal.locator('input[type="button"]')
        const choosing = page.waitForEvent('filechooser')
        await field.click()
        await (
            await choosing
        ).setFiles({ name: 'renamed.wav', mimeType: 'audio/wav', buffer: file })
        await expect(field).toHaveValue(/^00:/)
        await modal.getByRole('spinbutton', { name: 'Offset (ms)' }).fill('25')
        await modal.getByRole('button', { name: 'Confirm', exact: true }).click()
        await expect(modal).toHaveCount(0)
        await settled(page)
        expect(await liveBgm(page)).toEqual({ ...picked, offset: 0.025 })
        await expect.poll(() => storedCount(page, 'entries')).toBe(before + 1)
        // The toast, not the live region, which reads it too once the page's region is back.
        await expect(
            page.locator('.notification').filter({ hasText: 'Set BGM Offset to 25 ms' }),
        ).toBeVisible()
    })

    test('Choose Audio… with the same file takes the Undo card away', async ({ page }) => {
        await visit(page)
        await pickBgm(page, 'first.wav', wav(0.5, 5))
        const first = await liveBgm(page)
        await pickBgm(page, 'second.wav', wav(0.6, 9))
        await dropMedia(page, first.hash!)
        await reload(page)
        await expect.poll(() => liveBgm(page).then((bgm) => bgm.decoded)).toBe(true)
        await undo(page)
        await expect(notLoaded(page)).toHaveCount(1)

        await chooseAudio(page, 'first.wav', wav(0.5, 5))
        await expect(notLoaded(page)).toHaveCount(0)
        await expect
            .poll(() => liveBgm(page))
            .toEqual(expect.objectContaining({ hash: first.hash, decoded: true }))
    })

    test('Choose Audio… with another file is one BGM change that says it differs', async ({
        page,
    }) => {
        await visit(page)
        await pickBgm(page, 'pick.wav', wav(0.5, 5))
        const picked = await liveBgm(page)
        await dropMedia(page, picked.hash!)
        await reload(page)
        await expect(page.getByText('The BGM is not loaded.', { exact: true })).toBeVisible()
        const entries = await storedCount(page, 'entries')

        await chooseAudio(page, 'other.wav', wav(0.6, 9))
        await expect(
            page
                .locator('[data-notice-card]')
                .getByText('This is a different file from the original BGM, “pick.wav”.'),
        ).toBeVisible()
        const changed = await liveBgm(page)
        expect(changed).toMatchObject({
            filename: 'other.wav',
            decoded: true,
            offset: picked.offset,
        })
        expect(changed.hash).not.toBe(picked.hash)
        await settled(page)
        await expect.poll(() => storedCount(page, 'entries')).toBe(entries + 1)
    })

    test('opening the download it saved, with its BGM lost from storage, brings the BGM back', async ({
        page,
    }) => {
        await page.addInitScript(installTestPlatform, { fileSystemAccess: false })
        await visit(page)
        const file = wav(0.5)
        await pickBgm(page, 'pick.wav', file)
        const picked = await liveBgm(page)
        const downloading = page.waitForEvent('download')
        await pressSave(page)
        await submitSave(page, 'coconut')
        const download = await downloading
        const bytes = [...(await import('node:fs')).readFileSync((await download.path())!)]
        await settled(page)
        await dropMedia(page, picked.hash!)
        await reload(page)
        await expect(page.getByText('The BGM is not loaded.', { exact: true })).toBeVisible()

        // The session the file came from lacks its BGM: the open is today's, which stores it.
        await page.evaluate(async (bytes) => {
            const { openProject } = await import('/src/editor/commands/open/project.ts')
            await openProject(new File([new Uint8Array(bytes)], 'coconut.nxsp'), undefined)
        }, bytes)
        await expect.poll(() => liveBgm(page)).toEqual(picked)
        await expect.poll(() => storedCount(page, 'media')).toBe(1)
    })

    test('Download BGM gives back the bytes that were stored', async ({ page }) => {
        await visit(page)
        const file = wav(0.5)
        await pickBgm(page, 'pick.wav', file)
        const { hash } = await liveBgm(page)
        await page.keyboard.press('m')
        const modal = page.getByRole('dialog')
        const downloading = page.waitForEvent('download')
        await modal.getByRole('button', { name: 'Download BGM' }).click()
        const download = await downloading
        expect(download.suggestedFilename()).toBe('pick.wav')
        const path = await download.path()
        const { readFile } = await import('node:fs/promises')
        const { createHash } = await import('node:crypto')
        const bytes = await readFile(path)
        expect(createHash('sha256').update(bytes).digest('hex').startsWith(hash!)).toBe(true)
        expect(bytes.equals(file)).toBe(true)
    })

    test('the BGM dialog says a BGM nothing holds is not loaded, and has nothing to download', async ({
        page,
    }) => {
        await visit(page)
        await pickBgm(page, 'pick.wav', wav(0.5))
        const { hash } = await liveBgm(page)
        await dropMedia(page, hash!)
        await reload(page)
        await expect(page.getByText('The BGM is not loaded.', { exact: true })).toBeVisible()
        await page.keyboard.press('m')
        const modal = page.getByRole('dialog')
        await expect(modal.locator('input[type="button"]')).toHaveValue('BGM not loaded')
        await expect(modal.getByRole('button', { name: 'Download BGM' })).toHaveCount(0)
    })
})
