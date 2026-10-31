import { expect, test, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { minimalLevel } from '../editor/levelDataSynthetic'
import { gif, levelData, levelPackage, png, wav, webp } from './levelPackages'
import { builtinBytes, entriesOf, pack, patched, utf8 } from './previewAssetsPackages'
import {
    edit,
    notice,
    pauseAt,
    projectOf,
    queuePicks,
    reached,
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

test('a one-level package opens directly with its Level Info, cover, BGM and offset', async ({
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
})

test('a package opened in this tab is written over like any file the user picks', async ({
    page,
}) => {
    await start(page)
    // Save As onto a package whose list was closed writes the project there.
    await openPackageFile(page, 'skins.scp', await newEffect())
    await expect(list(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    await edit(page, 2)
    await queuePicks(page, ['skins.scp'])
    await page.evaluate(async () => {
        const { commands } = await import('/src/editor/commands/index.ts')
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        void runCommand(commands.saveAs, 'button')
    })
    await submitSave(page, 'skins', 'Save As')
    await expect(notice(page).filter({ hasText: 'Saved to skins.scp' })).toBeVisible()
    expect((await projectOf(page, 'skins.scp')).format).toBe('nxsp')

    // Export onto another package writes level data there.
    await openPackageFile(page, 'sounds.scp', await newEffect())
    await expect(list(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    await page.keyboard.press('Shift+P')
    await expect(dialog(page)).toHaveAccessibleName('Export Level Data')
    await queuePicks(page, ['sounds.scp'])
    await page.keyboard.press('Enter')
    await expect(notice(page).filter({ hasText: 'Exported to sounds.scp' })).toBeVisible()
    const written = new Uint8Array((await readFile(page, 'sounds.scp')) ?? [])
    expect(JSON.parse(new TextDecoder().decode(gunzipSync(written)))).toHaveProperty('entities')
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
        'No level data · Charter C',
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
    await particle.locator('[data-package-import]').focus()
    await page.keyboard.press('Enter')
    await expect(particle.locator('[data-package-in-use]')).toBeVisible({ timeout: 15_000 })
    // The result is announced, and the focus moves on to the next button.
    const status = dialog(page).locator('[data-package-status]')
    await expect(status).toHaveText('Editor · In use')
    const background = list(page).locator('[data-package-row]').nth(5)
    await expect(background.locator('[data-package-import]')).toBeFocused()
    // A failing Import says why under its row, and the focus stays on its button.
    await page.keyboard.press('Enter')
    const error = 'This file’s background image is not a PNG or JPEG image.'
    await expect(list(page).locator('[data-package-error]')).toHaveText(error)
    await expect(status).toHaveText(error)
    await expect(background.locator('[data-package-import]')).toBeFocused()
    // Use applies the stored choice; the focus moves on past the row.
    await row(page, 'Neon Skin').locator('[data-package-use]').click()
    await expect(row(page, 'Neon Skin').locator('[data-package-in-use]')).toBeVisible()
    await expect(status).toHaveText('Neon Skin · In use')
    await expect(background.locator('[data-package-import]')).toBeFocused()

    // A failed Open shows its message, then the same list again.
    await row(page, 'Level B').locator('[data-package-open]').click()
    await expect(dialog(page)).toContainText('This level’s data could not be read.')
    await page.keyboard.press('Escape')
    await expect(list(page)).toBeVisible()
    await expect(particle.locator('[data-package-in-use]')).toBeVisible()
    await expect(list(page).locator('[data-package-error]')).toHaveCount(1)
    // At the row that was pressed.
    await expect(row(page, 'Level B').locator('[data-package-open]')).toBeFocused()

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

test('a package with nothing the editor can use says so', async ({ page }) => {
    await start(page)
    await openPackageFile(
        page,
        'engines.scp',
        pack(new Map([['sonolus/engines/list', utf8('{"items":[{"name":"e"}]}')]])),
    )
    await expect(dialog(page)).toContainText('This Sonolus package contains no levels or assets.')
})

/** A package whose effect is the Built-in one in other bytes, so it offers Import. */
const newEffect = async () => {
    const entries = await entriesOf(builtinBytes('effect'))
    const list = JSON.parse(new TextDecoder().decode(entries.get('sonolus/effects/list'))) as {
        items: { data: { url: string } }[]
    }
    const data = entries.get(list.items[0]!.data.url.slice(1))!
    return patched('effect', {
        resources: { data: new Uint8Array(gzipSync(gunzipSync(data), { level: 1 })) },
    })
}

/**
 * Holds every audio decode until `releaseDecoding`: `decodeEntered` counts the decodes that began,
 * `decodeEnded` those that returned.
 */
const gateDecoding = (page: Page) =>
    page.evaluate(() => {
        const signals = window as unknown as {
            decodeEntered: number
            decodeEnded: number
            releaseDecoding: () => void
        }
        signals.decodeEntered = 0
        signals.decodeEnded = 0
        const gate = new Promise<void>((resolve) => (signals.releaseDecoding = resolve))
        const original = BaseAudioContext.prototype.decodeAudioData
        BaseAudioContext.prototype.decodeAudioData = async function (
            this: BaseAudioContext,
            data: ArrayBuffer,
        ) {
            signals.decodeEntered++
            await gate
            try {
                return await original.call(this, data)
            } finally {
                signals.decodeEnded++
            }
        } as typeof original
    })

const decodes = (page: Page) =>
    page.evaluate(() => {
        const { decodeEntered, decodeEnded } = window as unknown as Record<string, number>
        return { entered: decodeEntered, ended: decodeEnded }
    })

const releaseDecoding = (page: Page) =>
    page.evaluate(() => (window as unknown as { releaseDecoding: () => void }).releaseDecoding())

/** Opens a package without the Open command's confirmation, as another entry point would. */
const openUnconfirmed = (page: Page, name: string, bytes: Uint8Array) =>
    page.evaluate(
        async ({ name, bytes }) => {
            const { openPicked } = await import('/src/editor/commands/open/index.ts')
            void openPicked({ file: new File([new Uint8Array(bytes)], name), confirmed: false })
        },
        { name, bytes: Array.from(bytes) },
    )

/** How many BPM changes the chart has: an edit adds one. */
const bpmCount = (page: Page) =>
    page.evaluate(async () => {
        const { state } =
            (await import('/src/history/index.ts')) as typeof import('../../src/history')
        return state.value.bpms.length
    })

test('work that is not stored is asked about before a package level replaces it; Cancel keeps it', async ({
    page,
}) => {
    // Nothing is stored, so an edit is work that a switch would lose.
    await page.addInitScript(() => localStorage.setItem('nse.test.noStorage', 'true'))
    await start(page)
    await edit(page, 3)
    const before = await sessionOf(page)
    const bpms = await bpmCount(page)

    // A direct open asks just before the switch.
    await openUnconfirmed(page, 'one.scp', await levelPackage('full', [{ name: 'one' }]))
    const leave = page.getByRole('button', { name: 'Leave Anyway' })
    await expect(leave).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect((await sessionOf(page)).sessionId).toBe(before.sessionId)
    expect(await bpmCount(page)).toBe(bpms)
    await expect(notice(page).filter({ hasText: 'Opened level' })).toHaveCount(0)

    // The list asks nothing; its Open asks, with a request of its own, and Cancel shows it again.
    await openUnconfirmed(
        page,
        'two.scp',
        await levelPackage('full', [
            { name: 'a', title: 'Level A' },
            { name: 'b', title: 'Level B' },
        ]),
    )
    await expect(list(page)).toBeVisible()
    await row(page, 'Level B').locator('[data-package-open]').click()
    await expect(leave).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(list(page)).toBeVisible()
    await expect(row(page, 'Level B').locator('[data-package-open]')).toBeFocused()
    expect((await sessionOf(page)).sessionId).toBe(before.sessionId)
    expect(await bpmCount(page)).toBe(bpms)
})

test('Cancel while a level opens releases what it held and shows the list again at its row', async ({
    page,
}) => {
    await start(page)
    const cover = png(8, 8)
    const bytes = await levelPackage('full', [
        { name: 'a', title: 'Level A' },
        { name: 'b', title: 'Level B', cover, bgm: wav() },
    ])
    await openPackageFile(page, 'slow.scp', bytes)
    await expect(list(page)).toBeVisible()
    const before = await sessionOf(page)
    // Logs the open's end without pausing anything.
    await pauseAt(page, 'none')
    await gateDecoding(page)
    await row(page, 'Level B').locator('[data-package-open]').click()
    // The cover is held by now, and the BGM's decode has begun and waits.
    await expect.poll(async () => (await decodes(page)).entered).toBe(1)
    await page.keyboard.press('Escape')
    await expect(list(page)).toBeVisible()
    await expect(row(page, 'Level B').locator('[data-package-open]')).toBeFocused()
    // The decode returns and the cancelled task ends, publishing and holding nothing.
    await releaseDecoding(page)
    await reached(page, 'packageLevelEnded')
    expect(await decodes(page)).toEqual({ entered: 1, ended: 1 })
    expect((await sessionOf(page)).sessionId).toBe(before.sessionId)
    await expect(list(page)).toBeVisible()
    const hash = createHash('sha256').update(cover).digest('hex').slice(0, 32)
    expect(
        await page.evaluate(async (hash) => {
            const { heldItem } = await import('/src/local/heldMedia.ts')
            return heldItem(hash) !== undefined
        }, hash),
    ).toBe(false)
})

test('closing the list stops a running Import: nothing is stored or applied', async ({ page }) => {
    await start(page)
    await openPackageFile(page, 'sounds.scp', await newEffect())
    await expect(list(page)).toBeVisible()
    await pauseAt(page, 'none')
    await gateDecoding(page)
    await list(page).locator('[data-package-import]').click()
    // The Import is checking the clips, which wait.
    await expect.poll(async () => (await decodes(page)).entered).toBeGreaterThan(0)
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    // The Import goes on to its end, whatever that is, before anything is checked.
    await releaseDecoding(page)
    await reached(page, 'packageImportEnded')
    const state = await page.evaluate(async () => {
        const { workerStore } = await import('/src/preview/assets/files/store.ts')
        return {
            stored: (await workerStore.list()).length,
            effect: (await import('/src/settings.ts')).settings.previewAssets.effect,
        }
    })
    expect(state).toEqual({ stored: 0, effect: { source: 'default' } })
})

test('focus moved away during an Import stays where the user put it', async ({ page }) => {
    await start(page)
    await openPackageFile(page, 'sounds.scp', await newEffect())
    await expect(list(page)).toBeVisible()
    await pauseAt(page, 'none')
    await gateDecoding(page)
    await list(page).locator('[data-package-import]').click()
    await expect.poll(async () => (await decodes(page)).entered).toBeGreaterThan(0)
    const close = dialog(page).getByRole('button', { name: 'Close' })
    await close.focus()
    await releaseDecoding(page)
    await reached(page, 'packageImportEnded')
    await expect(list(page).locator('[data-package-in-use]')).toBeVisible()
    await expect(close).toBeFocused()
})
