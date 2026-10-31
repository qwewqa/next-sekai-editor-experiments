import { expect, test, type Page } from '@playwright/test'
import { minimalLevel } from '../editor/levelDataSynthetic'
import { gif, levelData, levelPackage, png, wav, webp } from './levelPackages'
import {
    notice,
    pressSave,
    queuePicks,
    readFile,
    sessionOf,
    start,
    submitSave,
    writeFile,
} from './saveFlows'

// Opening a Sonolus package with Open: one level opens directly, anything else shows the
// package's list. Chromium's pickers run on OPFS handles through the platform override, whose
// save picker empties an existing file as Chromium's does.

const dialog = (page: Page) => page.locator('dialog[open]')

/** Writes a package to OPFS and opens it with Open, as the picker would. */
const openPackageFile = async (page: Page, name: string, bytes: Uint8Array) => {
    await writeFile(page, name, bytes)
    await queuePicks(page, [name])
    await page.locator('canvas.editor-chart').focus()
    await page.keyboard.press('o')
}

const live = (page: Page) =>
    page.evaluate(async () => {
        const { state } =
            (await import('/src/history/index.ts')) as typeof import('../../src/history')
        const { levelInfo, bgm } = state.value
        return {
            levelInfo: {
                ...levelInfo,
                tags: levelInfo.tags.map((tag) => tag.title),
            },
            offset: bgm.offset,
            bgm: bgm.meta ? { size: bgm.meta.size, type: bgm.meta.type } : undefined,
            hasAudio: !!bgm.buffer,
            hasWaveform: !!bgm.waveform,
            notes: [...state.value.store.slides.note.values()].flat().length,
        }
    })

test('a one-level package opens directly with its Level Info, cover, BGM and offset, and Save and Export refuse it', async ({
    page,
}) => {
    await start(page)
    const bytes = await levelPackage('full', [
        {
            name: 'song',
            title: 'Song Title',
            artists: 'Artist',
            author: 'Charter',
            description: 'About it',
            rating: 27,
            tags: ['Hard'],
            data: levelData(minimalLevel(), 0.75),
            cover: png(4, 4),
            bgm: wav(),
            preview: wav(0.2),
        },
    ])
    await openPackageFile(page, 'song.scp', bytes)
    await expect(notice(page).filter({ hasText: 'Opened level' })).toBeVisible()
    await expect.poll(async () => (await live(page)).hasWaveform, { timeout: 15_000 }).toBe(true)
    const opened = await live(page)
    expect(opened.levelInfo).toMatchObject({
        title: 'Song Title',
        artists: 'Artist',
        author: 'Charter',
        description: 'About it',
        rating: 27,
        tags: ['Hard'],
        cover: { type: 'image/png' },
        preview: { type: 'audio/wav' },
    })
    expect(opened.offset).toBe(0.75)
    expect(opened.bgm).toEqual({ size: wav().length, type: 'audio/wav' })
    expect(opened.hasAudio).toBe(true)
    expect(opened.notes).toBe(1)
    // Named after the level, not the file.
    expect((await sessionOf(page)).sourceName).toBe('Song Title')

    // In the same visit, Save to the package is refused and its bytes stay as they were.
    await queuePicks(page, ['song.scp'])
    await pressSave(page)
    await submitSave(page, 'song')
    await expect(page.getByRole('dialog')).toContainText('“song.scp” is not a project file.')
    expect(await readFile(page, 'song.scp')).toEqual([...bytes])
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // And so is Export.
    await page.keyboard.press('Shift+P')
    await expect(dialog(page)).toHaveAccessibleName('Export Level Data')
    await queuePicks(page, ['song.scp'])
    await page.keyboard.press('Enter')
    await expect(dialog(page)).toContainText('“song.scp” is not level data.')
    expect(await readFile(page, 'song.scp')).toEqual([...bytes])
})

for (const [format, cover, type] of [
    ['WebP', webp(), 'image/webp'],
    ['GIF', gif(), 'image/gif'],
] as const)
    test(`a level with a ${format} cover opens with it`, async ({ page }) => {
        await start(page)
        await openPackageFile(
            page,
            'cover.scp',
            await levelPackage('full', [{ name: 'song', cover }]),
        )
        await expect(notice(page).filter({ hasText: 'Opened level' })).toBeVisible()
        expect((await live(page)).levelInfo.cover).toMatchObject({ type })
    })

test('media the editor cannot use is left out with a line; an empty SRL says nothing', async ({
    page,
}) => {
    await start(page)
    // A BGM that does not decode, and a cover over the canvas limit.
    await openPackageFile(
        page,
        'bad.scp',
        await levelPackage('full', [
            { name: 'song', bgm: new Uint8Array(4096).fill(7), cover: png(16_385, 1) },
        ]),
    )
    await expect(notice(page).filter({ hasText: 'Opened level' })).toBeVisible()
    await expect(notice(page)).toContainText('This level was opened without its cover.')
    await expect(notice(page)).toContainText('This level was opened without its BGM.')
    await expect(notice(page)).not.toContainText('preview audio')
    const opened = await live(page)
    expect(opened.levelInfo.cover).toBeUndefined()
    expect(opened.bgm).toBeUndefined()
})

test('data that is not level data fails in the loading dialog, and the session stays', async ({
    page,
}) => {
    await start(page)
    const before = (await sessionOf(page)).sessionId
    await openPackageFile(
        page,
        'broken.scp',
        await levelPackage('full', [{ name: 'song', data: new Uint8Array([1, 2, 3]) }]),
    )
    await expect(dialog(page)).toContainText('This level’s data could not be read.')
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    expect((await sessionOf(page)).sessionId).toBe(before)
})
