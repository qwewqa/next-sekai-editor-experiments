import { expect, test, type Page } from '@playwright/test'
import { gunzipSync, gzipSync } from 'node:zlib'
import { minimalLevel } from '../editor/levelDataSynthetic'
import { gif, levelData, levelPackage, png, wav, webp } from './levelPackages'
import { builtinBytes, entriesOf, pack, patched, utf8 } from './previewAssetsPackages'
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

/** Several packages' entries in one file. */
const merged = async (...parts: Uint8Array[]) => {
    const entries = new Map<string, Uint8Array>()
    for (const part of parts)
        for (const [name, data] of await entriesOf(part)) entries.set(name, data)
    return pack(entries)
}

/** A level package with assets beside its levels: a Built-in skin, a new particle, a bad background. */
const mixed = async () => {
    // Re-gzipped data: the same particle in other bytes, so it is not the Built-in one.
    const particle = await patched('particle', {
        resources: {
            data: new Uint8Array(gzipSync(gunzipSync(await particleData()), { level: 1 })),
        },
    })
    const background = await patched('background', { resources: { image: utf8('not an image') } })
    return merged(
        await levelPackage(
            'full',
            [
                { name: 'a', title: 'Level A', artists: 'Artist A', author: 'Charter A' },
                { name: 'b', title: 'Level B', data: new Uint8Array([1, 2, 3]) },
                { name: 'c', title: 'Level C', data: null, author: 'Charter C' },
            ],
            { skin: [{ name: 'neon', title: 'Neon Skin' }] },
        ),
        particle,
        background,
    )
}

/** The Built-in particle's data entry, gzipped. */
const particleData = async () => {
    const entries = await entriesOf(builtinBytes('particle'))
    const list = JSON.parse(new TextDecoder().decode(entries.get('sonolus/particles/list'))) as {
        items: { data: { url: string } }[]
    }
    return entries.get(list.items[0]!.data.url.slice(1))!
}

const list = (page: Page) => dialog(page).locator('[data-package-list]')
const row = (page: Page, title: string) =>
    list(page).locator('[data-package-row]').filter({ hasText: title })

test('the list: Open on each level with data, Import and Use on assets, and the list again after a failed Open', async ({
    page,
}) => {
    await start(page)
    const bytes = await mixed()
    await openPackageFile(page, 'mixed.scp', bytes)
    await expect(dialog(page)).toHaveAccessibleName('mixed')
    await expect(list(page).locator('[data-package-row-title]')).toHaveText([
        'Level A',
        'Level B',
        'Level C',
        'Neon Skin',
        'Editor',
        'Editor',
    ])
    await expect(row(page, 'Level A').locator('[data-package-row-detail]')).toHaveText(
        'Artist A · Charter A',
    )
    await expect(row(page, 'Level C').locator('[data-package-row-detail]')).toHaveText(
        'Level data not in this file · Charter C',
    )
    await expect(row(page, 'Level C').locator('button')).toHaveCount(0)
    // The skin is the Built-in one: Default is in use, so it offers Use under Built-in's name.
    await expect(row(page, 'Neon Skin').locator('[data-package-row-detail]')).toHaveText(
        /^Built-in · Skin/,
    )
    await expect(row(page, 'Neon Skin').locator('[data-package-use]')).toBeVisible()
    await expect(list(page).locator('[data-package-open]').first()).toBeFocused()

    // Import stores the particle and makes it the one in use.
    const particle = list(page).locator('[data-package-row]').nth(4)
    await expect(particle.locator('[data-package-row-detail]')).toHaveText(/^Particle/)
    await particle.locator('[data-package-import]').click()
    await expect(particle.locator('[data-package-in-use]')).toBeVisible({ timeout: 15_000 })
    // A failing Import says why under its row.
    const background = list(page).locator('[data-package-row]').nth(5)
    await background.locator('[data-package-import]').click()
    await expect(list(page).locator('[data-package-error]')).toHaveText(
        'This file’s background image is not a PNG or JPEG image.',
    )
    // Use applies the stored choice.
    await row(page, 'Neon Skin').locator('[data-package-use]').click()
    await expect(row(page, 'Neon Skin').locator('[data-package-in-use]')).toBeVisible()

    // A failed Open shows its message, then the same list again.
    await row(page, 'Level B').locator('[data-package-open]').click()
    await expect(dialog(page)).toContainText('This level’s data could not be read.')
    await page.keyboard.press('Escape')
    await expect(list(page)).toBeVisible()
    await expect(particle.locator('[data-package-in-use]')).toBeVisible()
    await expect(list(page).locator('[data-package-error]')).toHaveCount(1)

    // Open closes the list and opens the level.
    await row(page, 'Level A').locator('[data-package-open]').click()
    await expect(notice(page).filter({ hasText: 'Opened level' })).toBeVisible()
    await expect(list(page)).toHaveCount(0)
    expect((await sessionOf(page)).sourceName).toBe('Level A')

    // The same file again: the imported particle is in use.
    await queuePicks(page, ['mixed.scp'])
    await page.locator('canvas.editor-chart').focus()
    await page.keyboard.press('o')
    await expect(list(page)).toBeVisible()
    await expect(
        list(page).locator('[data-package-row]').nth(4).locator('[data-package-in-use]'),
    ).toBeVisible()
    await expect(row(page, 'Neon Skin').locator('[data-package-in-use]')).toBeVisible()
})

test('an asset-only package is refused as a Save destination after Import, and level data keeps its own refusal', async ({
    page,
}) => {
    await start(page)
    // The current session comes from level data, whose own refusal must still hold.
    const level = await page.evaluate(async () => {
        const { buildLevelDataVariants } = await import('/src/editor/commands/exportLevel/build.ts')
        const blob = (await buildLevelDataVariants())[0]
        return [...new Uint8Array(await blob!.arrayBuffer())]
    })
    await writeFile(page, 'LevelData', level)
    await queuePicks(page, ['LevelData'])
    await page.locator('canvas.editor-chart').focus()
    await page.keyboard.press('o')
    await expect(notice(page).filter({ hasText: 'Opened level' })).toBeVisible()

    const bytes = await levelPackage('full', [], { skin: [{ name: 'neon', title: 'Neon Skin' }] })
    await openPackageFile(page, 'skins.scp', bytes)
    await expect(list(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)

    for (const name of ['skins.scp', 'LevelData']) {
        await queuePicks(page, [name])
        await pressSave(page)
        await submitSave(page, 'song')
        await expect(page.getByRole('dialog')).toContainText(`“${name}” is not a project file.`)
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog')).toHaveCount(0)
    }
    expect(await readFile(page, 'skins.scp')).toEqual([...bytes])
    expect(await readFile(page, 'LevelData')).toEqual(level)
})

test('a package with nothing the editor can use says so', async ({ page }) => {
    await start(page)
    await openPackageFile(
        page,
        'engines.scp',
        pack(new Map([['sonolus/engines/list', utf8('{"items":[{"name":"e"}]}')]])),
    )
    await expect(dialog(page)).toContainText('This Sonolus package contains no levels or assets.')
})
