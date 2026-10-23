import { expect, test, type Page } from '@playwright/test'
import { waitForStartup } from './editorFixture'
import { skipWhereTheEditorCannotStart } from './webkitSupport'

// Media re-attach (Part 1 §1.6.8.4, Step 7 design §3.6): a session whose BGM is in the media store
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
        await expect(page.getByText('The BGM is not loaded.')).toHaveCount(0)
    })
})
