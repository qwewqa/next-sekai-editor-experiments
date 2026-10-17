import { expect, test, type Locator, type Page } from '@playwright/test'
import type { EffectData, ParticleData, SkinData } from '@sonolus/core'
import { mkdirSync } from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'
import { pngHeader } from '../preview/files/fixtures'
import { installCanvasCounters, installEditorFixture } from './editorFixture'
import {
    builtinBytes,
    collection,
    patched,
    rawZip,
    types,
    utf8,
    variants,
    type Type,
} from './previewAssetsPackages'
import { resource } from './previewResourceFixture'

// The Preview Assets dialog with From a File (Part 2, 2.5.2, 2.6; the A3 tests of 2.11). With
// A3_SHOTS_DIR set, each state is also saved there as a screenshot.
const shotsDir = process.env.A3_SHOTS_DIR
if (shotsDir) mkdirSync(shotsDir, { recursive: true })

const KEY = 'sonolus-next-sekai-editor.'
const dialog = (page: Page) => page.locator('dialog[open]')
const chooser = (page: Page) => dialog(page).locator('[data-asset-chooser]')
const fallbackLine = (page: Page, type: string) => page.locator(`[data-asset-fallback="${type}"]`)

const start = async (page: Page, seed: Record<string, unknown> = {}) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/resource/skin.scp*', (route) => route.fulfill({ body: resource('skins') }))
    await page.route('**/resource/particle.scp*', (route) =>
        route.fulfill({ body: resource('particles') }),
    )
    await page.addInitScript(installCanvasCounters)
    await page.addInitScript(
        ([prefix, seed]) => {
            if (sessionStorage.getItem('seeded')) return
            sessionStorage.setItem('seeded', '1')
            for (const [key, value] of Object.entries(seed as Record<string, unknown>))
                localStorage.setItem(prefix + key, JSON.stringify(value))
        },
        [KEY, seed] as const,
    )
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.evaluate(() => {
        window.editorTest.settings.showPreview = true
        window.editorTest.settings.previewControls = 'collapsed'
    })
    return errors
}

const open = async (page: Page, tab?: Type | 'stored') => {
    await page.evaluate(async (tab) => {
        const { showPreviewAssets } = await import('/src/editor/commands/previewAssets/modal.ts')
        await showPreviewAssets(tab)
        await window.editorTest.nextTick()
    }, tab)
    await expect(dialog(page)).toHaveAccessibleName('Preview Assets')
    await expect(
        dialog(page)
            .locator('[data-asset-sources], [data-stored-list], [data-stored-empty]')
            .first(),
    ).toBeVisible()
}

const tabOf = (page: Page, type: string) =>
    dialog(page).locator(`[data-preview-assets-tab="${type}"]`)
const selectedTab = (page: Page) => dialog(page).getByRole('tab', { selected: true })

type Choice = { source: string; title?: string; name?: string; origin?: string; key?: string }
const choices = (page: Page) =>
    page.evaluate(
        () => window.editorTest.settings.previewAssets as unknown as Record<string, Choice>,
    )

const shot = async (page: Page, name: string, target?: Locator) => {
    if (!shotsDir) return
    // Let the thumbnails and the fonts settle, with no hover left on what was clicked.
    await page.mouse.move(0, 0)
    await page.waitForTimeout(400)
    await (target ?? page).screenshot({ path: `${shotsDir}/${name}.png` })
}

/** Picks a file in the open chooser the way a user does: the button, then the system dialog. */
const pick = async (page: Page, name: string, bytes: Uint8Array) => {
    const chosen = page.waitForEvent('filechooser')
    await chooser(page).locator('[data-chooser-select-file]').click()
    await (
        await chosen
    ).setFiles({
        name,
        mimeType: 'application/octet-stream',
        buffer: Buffer.from(bytes),
    })
}

const choose = async (page: Page) => {
    await dialog(page).locator('[data-asset-choose]').click()
    await expect(chooser(page)).toBeVisible()
}

const slot = (page: Page, type: string) =>
    page.evaluate(async (type) => {
        const { assetSession } = await window.editorTest.appImport<
            typeof import('../../src/preview/assets')
        >('/src/preview/assets/index.ts')
        const slots = assetSession.slots as unknown as Record<
            string,
            { value: { state: string; status?: unknown; value?: { title?: string } } }
        >
        const { state, status, value } = slots[type]?.value ?? { state: 'none' }
        return { state, status, title: value?.title }
    }, type)

const stored = (page: Page) =>
    page.evaluate(async () => {
        const { workerStore } = await window.editorTest.appImport<
            typeof import('../../src/preview/assets/files/store')
        >('/src/preview/assets/files/store.ts')
        return await workerStore.list()
    })

/** Stores a package straight into the store, as an earlier session would have. */
const store = (
    page: Page,
    record: { type: Type; name: string; title: string; bytes: Uint8Array },
) =>
    page.evaluate(
        async ({ type, name, title, bytes }) => {
            const { workerStore } = await window.editorTest.appImport<
                typeof import('../../src/preview/assets/files/store')
            >('/src/preview/assets/files/store.ts')
            const blob = new Blob([new Uint8Array(bytes)])
            const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
                byte.toString(16).padStart(2, '0'),
            ).join('')
            await workerStore.put({
                key,
                type,
                name,
                title,
                author: 'Someone',
                origin: 'stored.scp',
                bytes: blob,
                size: blob.size,
                addedAt: Date.now(),
                lastUsedAt: Date.now(),
            })
            return key
        },
        { ...record, bytes: Array.from(record.bytes) } as never,
    )

/** Imports through the chooser, and leaves the chooser closed. */
const importFile = async (page: Page, type: Type, name: string, bytes: Uint8Array) => {
    await tabOf(page, type).click()
    await choose(page)
    await pick(page, name, bytes)
    await expect(chooser(page).locator('[data-chooser-use]')).toBeEnabled()
    await chooser(page).locator('[data-chooser-use]').click()
    await expect(chooser(page)).toHaveCount(0)
}

/** Slows the sound effects' decoding, so an import stays "working" for a while. */
const slowDecoding = (page: Page, ms: number) =>
    page.evaluate((ms) => {
        const original = OfflineAudioContext.prototype.decodeAudioData
        OfflineAudioContext.prototype.decodeAudioData = async function (
            this: OfflineAudioContext,
            data: ArrayBuffer,
        ) {
            await new Promise((resolve) => setTimeout(resolve, ms))
            return original.call(this, data)
        } as typeof original
    }, ms)

const fileChoice = {
    source: 'file',
    key: 'abc',
    name: 'neon',
    title: 'Neon Skin',
    author: 'Someone',
    origin: 'neon.scp',
}

/** A background choice whose package is not stored. */
const nightSky = {
    ...fileChoice,
    key: 'def',
    name: 'night',
    title: 'Night Sky',
    origin: 'night.scp',
}

const jsonOf = <T>(gz: Uint8Array) => JSON.parse(gunzipSync(gz).toString()) as T
const gzOf = (value: unknown) => new Uint8Array(gzipSync(JSON.stringify(value)))

/** An entry of a Built-in package, read back through its SRL. */
const resourceOf = async (type: Type, field: string) => {
    const { ZipReader } = await import('../../src/zip')
    const reader = await ZipReader.open(new Blob([new Uint8Array(builtinBytes(type))]))
    const category = {
        skin: 'skins',
        particle: 'particles',
        background: 'backgrounds',
        effect: 'effects',
    }[type]
    const list = JSON.parse(
        new TextDecoder().decode(
            await reader.read(reader.get(`sonolus/${category}/list`)!, { maxSize: 1e6 }),
        ),
    ) as { items: Record<string, { url: string }>[] }
    const entry = reader.get(list.items[0]![field]!.url.replace(/^\//, ''))!
    return new Uint8Array(await reader.read(entry, { maxSize: 1e8 }))
}

test.describe('From a File', () => {
    test('a skin is picked, used, stored and shown', async ({ page }) => {
        const errors = await start(page)
        await open(page)
        await expect(dialog(page).locator('[data-asset-choose]')).toHaveText('Choose…')
        await choose(page)
        await expect(chooser(page).locator('[data-chooser-title]')).toHaveText('Choose a Skin')
        await expect(chooser(page).locator('[data-chooser-rights]')).toHaveText(
            'Items you load are stored in this browser only. Use only items you are allowed to use.',
        )
        // Nothing is listed, and Use waits for an item.
        await expect(chooser(page).locator('[data-chooser-list]')).toHaveCount(0)
        await expect(chooser(page).locator('[data-chooser-use]')).toBeDisabled()

        await pick(
            page,
            'editor-skin.scp',
            await variants('skin', [{ name: 'neon', title: 'Neon Skin', author: 'Someone' }]),
        )
        const item = chooser(page).locator('[data-chooser-item="neon"]')
        await expect(item).toContainText('Neon Skin')
        await expect(item).toContainText('Someone')
        // A lone item is selected already, and Use has focus.
        await expect(item.locator('input')).toBeChecked()
        await expect(chooser(page).locator('[data-chooser-use]')).toBeFocused()
        await expect(chooser(page).locator('[data-chooser-file-name]')).toHaveText(
            'editor-skin.scp',
        )

        await chooser(page).locator('[data-chooser-use]').click()
        await expect(chooser(page)).toHaveCount(0)
        // The source list shows the new item, selected.
        const row = dialog(page).locator('[data-asset-row^="file:"]')
        await expect(row).toContainText('Neon Skin (File)')
        await expect(row).toContainText('Someone · editor-skin.scp')
        await expect(row.locator('input')).toBeChecked()
        expect((await choices(page)).skin).toMatchObject({
            source: 'file',
            title: 'Neon Skin',
            name: 'neon',
            author: 'Someone',
            origin: 'editor-skin.scp',
        })

        // It is stored, the footer counts it and the preview shows it.
        expect(await stored(page)).toHaveLength(1)
        await expect(dialog(page).locator('[data-stored-line]')).toHaveText(
            /^Stored: 1 item, [\d.]+ kB$/,
        )
        await expect
            .poll(() => slot(page, 'skin'))
            .toMatchObject({ state: 'ready', status: { active: 'chosen' }, title: 'Neon Skin' })
        expect(errors).toEqual([])
    })

    test('the stored item is still chosen and loads after a reload', async ({ page }) => {
        await start(page)
        await open(page)
        await importFile(
            page,
            'skin',
            'neon.scp',
            await variants('skin', [{ name: 'neon', title: 'Neon Skin' }]),
        )
        await page.reload()
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await page.evaluate(installEditorFixture)
        await page.evaluate(() => {
            window.editorTest.settings.showPreview = true
        })
        await expect
            .poll(() => slot(page, 'skin'), { timeout: 15_000 })
            .toMatchObject({ state: 'ready', status: { active: 'chosen' }, title: 'Neon Skin' })
        expect(await stored(page)).toHaveLength(1)
    })

    test('every type can be picked from a file and is shown', async ({ page }) => {
        await start(page)
        await open(page)
        for (const type of types)
            await importFile(
                page,
                type,
                `${type}.scp`,
                await variants(type, [{ name: 'item', title: `Own ${type}` }]),
            )
        for (const type of types)
            await expect
                .poll(() => slot(page, type), { timeout: 15_000 })
                .toMatchObject({
                    state: 'ready',
                    status: { active: 'chosen' },
                    title: `Own ${type}`,
                })
        expect(await stored(page)).toHaveLength(4)
        // A file background shows with its image's own aspect ratio when its data has none.
        const background = await page.evaluate(async () => {
            const { assetSession } = await window.editorTest.appImport<
                typeof import('../../src/preview/assets')
            >('/src/preview/assets/index.ts')
            return assetSession.slots.background.value.value?.aspectRatio
        })
        expect(background).toBeGreaterThan(0)
    })

    test('other types of the same name are offered, and Use applies the ticked ones', async ({
        page,
    }) => {
        await start(page)
        await open(page)
        await choose(page)
        const pack = await collection({
            skin: [{ name: 'neon', title: 'Neon Skin' }],
            particle: [{ name: 'neon', title: 'Neon Particle' }],
            background: [{ name: 'night', title: 'Night Sky' }],
            effect: [{ name: 'neon', title: 'Neon Sounds' }],
        })
        await pick(page, 'neon-pack.scp', pack)
        const also = chooser(page).locator('[data-chooser-also]')
        // One checkbox for the particle and one for the sound effects; the background has another name.
        await expect(also.locator('label')).toHaveCount(2)
        await expect(also).toContainText('Also use the particle "Neon Particle" from this file')
        await expect(also).toContainText('Also use the sound effects "Neon Sounds" from this file')
        await expect(also.locator('input:checked')).toHaveCount(0)
        await also.locator('[data-chooser-also-type="particle"]').check()
        await chooser(page).locator('[data-chooser-use]').click()
        await expect(chooser(page)).toHaveCount(0)

        const now = await choices(page)
        expect(now.skin).toMatchObject({ source: 'file', title: 'Neon Skin' })
        expect(now.particle).toMatchObject({ source: 'file', title: 'Neon Particle' })
        // Unticked types stay as they were.
        expect(now.effect).toEqual({ source: 'default' })
        expect(now.background).toEqual({ source: 'default' })
        expect(await stored(page)).toHaveLength(2)
        // The particle's tab shows it too.
        await tabOf(page, 'particle').click()
        await expect(dialog(page).locator('[data-asset-row^="file:"]')).toContainText(
            'Neon Particle (File)',
        )
        await expect(dialog(page).locator('[data-stored-line]')).toHaveText(/^Stored: 2 items, /)
    })

    test('a package with several items lists them and selects none', async ({ page }) => {
        await start(page)
        await open(page)
        await choose(page)
        await pick(
            page,
            'skins.scp',
            await variants('skin', [
                { name: 'a', title: 'First Skin', author: 'Ann' },
                { name: 'b', title: 'Second Skin', author: 'Bo' },
                { name: 'c', title: 'Third Skin', author: 'Cy' },
            ]),
        )
        const items = chooser(page).locator('[data-chooser-item]')
        await expect(items).toHaveCount(3)
        await expect(chooser(page).locator('[data-chooser-item] input:checked')).toHaveCount(0)
        await expect(chooser(page).locator('[data-chooser-use]')).toBeDisabled()
        // The list has the focus, so the arrow keys work at once.
        await expect(items.first().locator('input')).toBeFocused()
        await items.nth(1).click()
        await expect(chooser(page).locator('[data-chooser-use]')).toBeEnabled()
        await chooser(page).locator('[data-chooser-use]').click()
        await expect(dialog(page).locator('[data-asset-row^="file:"]')).toContainText(
            'Second Skin (File)',
        )
        expect(await stored(page)).toHaveLength(1)
    })

    test('a file with no item of the type says so', async ({ page }) => {
        await start(page)
        await open(page)
        await choose(page)
        await pick(page, 'particle.scp', builtinBytes('particle'))
        await expect(chooser(page).locator('[data-chooser-empty]')).toHaveText(
            'This file has no skin.',
        )
        await expect(chooser(page).locator('[data-chooser-use]')).toBeDisabled()
        // The same file in the Particle tab has its item.
        await chooser(page).locator('[data-chooser-cancel]').click()
        await tabOf(page, 'particle').click()
        await choose(page)
        await pick(page, 'particle.scp', builtinBytes('particle'))
        await expect(chooser(page).locator('[data-chooser-item]')).toHaveCount(1)
    })

    test('Cancel returns to the source list and leaves the previous choice', async ({ page }) => {
        await start(page, { previewAssets: { skin: { source: 'builtin' } } })
        await open(page)
        await choose(page)
        await pick(page, 'neon.scp', await variants('skin', [{ name: 'neon', title: 'Neon Skin' }]))
        await expect(chooser(page).locator('[data-chooser-item]')).toHaveCount(1)
        await chooser(page).locator('[data-chooser-cancel]').click()
        await expect(chooser(page)).toHaveCount(0)
        await expect(dialog(page).locator('[data-asset-row="builtin"] input')).toBeChecked()
        expect(await stored(page)).toHaveLength(0)
        expect((await choices(page)).skin).toEqual({ source: 'builtin' })
    })

    test('a file picked in Open File opens the dialog on its first type, already listed', async ({
        page,
    }) => {
        await start(page)
        // No skin in it: the first type it holds, in tab order, is the particle.
        const pack = await collection({
            particle: [{ name: 'neon', title: 'Neon Particle' }],
            effect: [{ name: 'neon', title: 'Neon Sounds' }],
        })
        await page.evaluate(
            async ({ bytes }) => {
                const { showPreviewAssets } =
                    await import('/src/editor/commands/previewAssets/modal.ts')
                const file = new File([new Uint8Array(bytes)], 'from-open.scp')
                await showPreviewAssets('skin', { file })
            },
            { bytes: Array.from(pack) },
        )
        await expect(dialog(page)).toHaveAccessibleName('Preview Assets')
        await expect(selectedTab(page)).toHaveText('Particle')
        // The items are listed without a second pick.
        await expect(chooser(page).locator('[data-chooser-item]')).toHaveCount(1)
        await expect(chooser(page).locator('[data-chooser-item]')).toContainText('Neon Particle')
        await expect(chooser(page).locator('[data-chooser-file-name]')).toHaveText('from-open.scp')
        await expect(chooser(page).locator('[data-chooser-also]')).toContainText(
            'Also use the sound effects "Neon Sounds" from this file',
        )
    })

    test('the tabs keep their choosers, and an import goes on while another tab shows', async ({
        page,
    }) => {
        await start(page)
        await open(page, 'effect')
        await slowDecoding(page, 800)
        await choose(page)
        await pick(
            page,
            'sounds.scp',
            await variants('effect', [{ name: 'neon', title: 'Neon Sounds' }]),
        )
        await chooser(page).locator('[data-chooser-use]').click()
        await expect(chooser(page).locator('[data-chooser-progress]')).toHaveText(/Storing…/)
        await expect(chooser(page).locator('[data-chooser-use]')).toBeDisabled()

        // Another tab has its own chooser; this one goes on in the background.
        await tabOf(page, 'skin').click()
        await expect(dialog(page).locator('[data-asset-sources]')).toBeVisible()
        await expect(chooser(page)).toHaveCount(0)
        await tabOf(page, 'effect').click()
        await expect(chooser(page).locator('[data-chooser-progress]')).toBeVisible()
        await expect(chooser(page)).toHaveCount(0, { timeout: 15_000 })
        await expect(dialog(page).locator('[data-asset-row^="file:"]')).toContainText(
            'Neon Sounds (File)',
        )
        // An open chooser also stays open across tabs.
        await tabOf(page, 'skin').click()
        await choose(page)
        await tabOf(page, 'particle').click()
        await expect(chooser(page)).toHaveCount(0)
        await tabOf(page, 'skin').click()
        await expect(chooser(page)).toBeVisible()
    })

    test('closing the dialog cancels an import and stores nothing', async ({ page }) => {
        await start(page)
        await open(page, 'effect')
        await slowDecoding(page, 1500)
        await choose(page)
        await pick(
            page,
            'sounds.scp',
            await variants('effect', [{ name: 'neon', title: 'Neon Sounds' }]),
        )
        await chooser(page).locator('[data-chooser-use]').click()
        await expect(chooser(page).locator('[data-chooser-progress]')).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(dialog(page)).toHaveCount(0)
        // Well past the slowed decoding: nothing was stored and the choice is as it was.
        await page.waitForTimeout(2500)
        expect(await stored(page)).toHaveLength(0)
        expect((await choices(page)).effect).toEqual({ source: 'default' })
    })
})

test.describe('a stored item that is gone', () => {
    test('Default is used with the reason, the setting stays, and Choose Again picks it anew', async ({
        page,
    }) => {
        await start(page, { previewAssets: { skin: fileChoice } })
        await open(page)
        const note = dialog(page).locator('[data-asset-note]')
        await expect(note).toContainText(
            'Using Default. The skin file is no longer stored in this browser.',
        )
        // The panel's line gives the same reason.
        await expect(fallbackLine(page, 'skin')).toContainText(
            'Skin: using Default. The skin file is no longer stored in this browser.',
        )
        await expect(tabOf(page, 'skin')).toHaveAccessibleName(
            'Skin. The skin file is no longer stored in this browser.',
        )
        expect((await choices(page)).skin).toEqual(fileChoice)

        await dialog(page).locator('[data-asset-choose-again]').click()
        await expect(chooser(page)).toBeVisible()
        // Cancelling leaves the setting as it was.
        await chooser(page).locator('[data-chooser-cancel]').click()
        expect((await choices(page)).skin).toEqual(fileChoice)

        await dialog(page).locator('[data-asset-choose-again]').click()
        await pick(
            page,
            'neon.scp',
            await variants('skin', [{ name: 'neon', title: 'Neon Skin', author: 'Someone' }]),
        )
        await chooser(page).locator('[data-chooser-use]').click()
        await expect(chooser(page)).toHaveCount(0)
        // The choice is now the stored package, and the reason is gone.
        const now = (await choices(page)).skin
        expect(now?.key).not.toBe('abc')
        expect(now?.source).toBe('file')
        await expect(dialog(page).locator('[data-asset-note]')).toHaveCount(0)
        await expect(tabOf(page, 'skin')).toHaveAccessibleName('Skin')
        await expect(fallbackLine(page, 'skin')).toHaveCount(0)
    })

    test('a stored package that cannot be read says so, in the panel and in the dialog', async ({
        page,
    }) => {
        await start(page)
        const key = await store(page, {
            type: 'skin',
            name: 'neon',
            title: 'Neon Skin',
            bytes: await patched('skin', { resources: { texture: pngHeader(8192, 8192) } }),
        })
        await page.evaluate((key) => {
            window.editorTest.settings.previewAssets = {
                ...window.editorTest.settings.previewAssets,
                skin: {
                    source: 'file',
                    key,
                    name: 'neon',
                    title: 'Neon Skin',
                    author: 'Someone',
                    origin: 'stored.scp',
                },
            } as never
        }, key)
        await expect(fallbackLine(page, 'skin')).toContainText(
            'Skin: using Default. The stored skin could not be read.',
        )
        await open(page)
        await expect(dialog(page).locator('[data-asset-note]')).toContainText(
            'Using Default. The stored skin could not be read.',
        )
        // Only a gone file offers Choose Again.
        await expect(dialog(page).locator('[data-asset-choose-again]')).toHaveCount(0)
        expect((await choices(page)).skin?.key).toBe(key)
    })
})

test.describe('storage that cannot be opened', () => {
    test('a stored choice cannot be read, which is not gone: no Choose Again, and the setting stays', async ({
        page,
    }) => {
        await page.addInitScript(() => localStorage.setItem('nse.test.noStorage', '1'))
        await start(page, { previewAssets: { skin: fileChoice } })
        const reason =
            'The stored skin cannot be read while this browser’s storage cannot be opened.'
        await expect(fallbackLine(page, 'skin')).toContainText(`Skin: using Default. ${reason}`)
        await open(page, 'skin')
        await expect(dialog(page).locator('[data-asset-note]')).toHaveText(
            `Using Default. ${reason}`,
        )
        await expect(dialog(page).locator('[data-asset-choose-again]')).toHaveCount(0)
        expect((await choices(page)).skin).toEqual(fileChoice)

        await tabOf(page, 'stored').click()
        await expect(dialog(page).locator('[data-stored-unavailable]')).toHaveText(
            'Stored items cannot be read while this browser’s storage cannot be opened.',
        )
        await expect(dialog(page).locator('[data-stored-empty]')).toHaveCount(0)
    })
})

test.describe('the Stored tab', () => {
    test('lists the items with their sizes, marks one in use, and removes after asking', async ({
        page,
    }) => {
        await start(page)
        await open(page)
        await importFile(
            page,
            'skin',
            'neon.scp',
            await variants('skin', [{ name: 'neon', title: 'Neon Skin' }]),
        )
        await importFile(
            page,
            'particle',
            'spark.scp',
            await variants('particle', [{ name: 'spark', title: 'Spark' }]),
        )
        // The particle is not the one in use once the choice goes back to Built-in.
        await tabOf(page, 'particle').click()
        await dialog(page).locator('[data-asset-row="builtin"]').click()

        await tabOf(page, 'stored').click()
        const items = dialog(page).locator('[data-stored-item]')
        await expect(items).toHaveCount(2)
        const neon = items.filter({ hasText: 'Neon Skin' })
        const spark = items.filter({ hasText: 'Spark' })
        await expect(neon).toContainText('Skin · neon.scp')
        await expect(neon.locator('[data-stored-size]')).toHaveText(/^[\d.]+ kB$/)
        await expect(neon.locator('[data-stored-in-use]')).toHaveText('In use')
        await expect(spark.locator('[data-stored-in-use]')).toHaveCount(0)
        await expect(dialog(page).locator('[data-stored-line]')).toHaveText(/^Stored: 2 items, /)

        // One that is not in use goes at once.
        await spark.locator('[data-stored-remove]').click()
        await expect(items).toHaveCount(1)
        await expect(dialog(page).locator('[data-stored-line]')).toHaveText(/^Stored: 1 item, /)
        expect(await stored(page)).toHaveLength(1)

        // One in use asks first, with Cancel as the default.
        await neon.locator('[data-stored-remove]').click()
        const confirm = page.locator('dialog[open]').last()
        await expect(confirm).toContainText('Remove "Neon Skin"? Default is used instead.')
        await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
        // A press in a dialog's first moments is not a choice.
        await page.waitForTimeout(400)
        await confirm.getByRole('button', { name: 'Cancel' }).click()
        await expect(page.locator('dialog[open]')).toHaveCount(1)
        await expect(items).toHaveCount(1)
        expect((await choices(page)).skin?.source).toBe('file')

        await neon.locator('[data-stored-remove]').click()
        await expect(page.locator('dialog[open]')).toHaveCount(2)
        await page.waitForTimeout(400)
        await page.locator('dialog[open]').last().getByRole('button', { name: 'Remove' }).click()
        await expect(dialog(page).locator('[data-stored-empty]')).toHaveText('No stored items')
        await expect(dialog(page).locator('[data-stored-line]')).toHaveCount(0)
        expect(await stored(page)).toHaveLength(0)
        // The type that used it uses Default again.
        expect((await choices(page)).skin).toEqual({ source: 'default' })
        await tabOf(page, 'skin').click()
        await expect(dialog(page).locator('[data-asset-row="default"] input')).toBeChecked()
    })

    test('the footer reads one item in the singular, and says nothing with none', async ({
        page,
    }) => {
        await start(page)
        await open(page, 'stored')
        await expect(dialog(page).locator('[data-stored-empty]')).toBeVisible()
        await expect(dialog(page).locator('[data-stored-line]')).toHaveCount(0)
        await store(page, {
            type: 'skin',
            name: 'neon',
            title: 'Neon Skin',
            bytes: await variants('skin', [{ name: 'neon', title: 'Neon Skin' }]),
        })
        await page.evaluate(async () => {
            const { refreshStored } = await window.editorTest.appImport<
                typeof import('../../src/preview/assets/files/store')
            >('/src/preview/assets/files/store.ts')
            await refreshStored()
        })
        await expect(dialog(page).locator('[data-stored-line]')).toHaveText(
            /^Stored: 1 item, [\d.]+ kB$/,
        )
    })
})

test.describe('the source list', () => {
    test('arrowing through it never opens the chooser', async ({ page }) => {
        await start(page)
        await open(page)
        await importFile(
            page,
            'skin',
            'neon.scp',
            await variants('skin', [{ name: 'neon', title: 'Neon Skin' }]),
        )
        // Default, Built-in and the stored item, with Choose… outside the group.
        await expect(dialog(page).locator('[data-asset-row]')).toHaveCount(3)
        await dialog(page).locator('[data-asset-row] input:checked').focus()
        const seen: (string | undefined)[] = []
        for (const key of [
            'ArrowUp',
            'ArrowUp',
            'ArrowUp',
            'ArrowDown',
            'ArrowDown',
            'ArrowDown',
        ]) {
            await page.keyboard.press(key)
            seen.push((await choices(page)).skin?.source)
            await expect(chooser(page)).toHaveCount(0)
            await expect(dialog(page)).toHaveCount(1)
        }
        // Every step switched the preview; none opened anything.
        expect(new Set(seen).size).toBeGreaterThan(1)
        await expect(dialog(page).locator('[data-asset-choose]')).toBeVisible()
    })
})

test.describe('a stored item that is slow to load', () => {
    test('shows Loading… under its row until it is shown', async ({ page }) => {
        await start(page)
        await open(page)
        await importFile(
            page,
            'skin',
            'neon.scp',
            await variants('skin', [{ name: 'neon', title: 'Neon Skin' }]),
        )
        await dialog(page).locator('[data-asset-row="builtin"]').click()
        await expect.poll(() => slot(page, 'skin')).toMatchObject({ status: { active: 'builtin' } })
        await expect(dialog(page).locator('[data-asset-loading]')).toHaveCount(0)

        // The store answers slowly for a while.
        await page.evaluate(async () => {
            const { workerStore } = await window.editorTest.appImport<
                typeof import('../../src/preview/assets/files/store')
            >('/src/preview/assets/files/store.ts')
            const get = workerStore.get
            workerStore.get = async (key) => {
                await new Promise((resolve) => setTimeout(resolve, 2500))
                return get(key)
            }
        })
        await dialog(page).locator('[data-asset-row^="file:"]').click()
        const loading = dialog(page).locator('[data-asset-loading]')
        await expect(loading).toHaveText('Loading…')
        // It sits under the chosen row, and goes when the item shows.
        await expect(
            dialog(page).locator('[data-asset-row^="file:"] + [data-asset-loading]'),
        ).toHaveCount(1)
        await expect
            .poll(() => slot(page, 'skin'), { timeout: 15_000 })
            .toMatchObject({ status: { active: 'chosen' }, title: 'Neon Skin' })
        await expect(loading).toHaveCount(0)
    })
})

test.describe('refusing a file', () => {
    // A package that cannot be opened is refused when it is picked; an item that fails a check, at Use.
    const refused = async (page: Page, bytes: Uint8Array, message: string) => {
        await pick(page, 'bad.scp', bytes)
        const error = chooser(page).locator('[data-chooser-error]')
        await expect(
            chooser(page).locator('[data-chooser-item], [data-chooser-error]').first(),
        ).toBeVisible()
        if ((await error.count()) === 0) await chooser(page).locator('[data-chooser-use]').click()
        await expect(error).toHaveText(message)
        // Nothing was stored.
        await expect(chooser(page)).toBeVisible()
    }

    test('each way a package can be wrong is refused with its message', async ({ page }) => {
        test.setTimeout(90_000)
        await start(page)
        await open(page)
        await choose(page)

        const good = await variants('skin', [{ name: 'neon' }])
        const skinTexture = await resourceOf('skin', 'texture')
        void skinTexture
        const damaged = 'This file is damaged or is not a Sonolus package.'

        await refused(page, good.slice(0, good.length - 12), damaged)
        await refused(page, utf8('not a package'), damaged)

        // ZIP64: the same entries with a ZIP64 end record.
        const { ZipReader } = await import('../../src/zip')
        const reader = await ZipReader.open(new Blob([new Uint8Array(good)]))
        const entries = []
        for (const entry of reader.entries)
            entries.push({
                name: entry.name,
                method: 0 as const,
                data: await reader.read(entry, { maxSize: 1e8 }),
            })
        await refused(
            page,
            rawZip(entries, { zip64End: true }),
            'This file uses ZIP64, which the editor cannot read.',
        )

        // A ratio bomb: 30 MB of zeros deflated into a texture.
        await refused(
            page,
            await patched('skin', {
                resources: { texture: new Uint8Array(30_000_000) },
                deflate: ['texture'],
            }),
            'This file’s skin texture expands to more than 200 times its size.',
        )

        const unreadable = 'This file’s skin data could not be read.'
        await refused(
            page,
            await patched('skin', { resources: { data: new Uint8Array(gzipSync('not json')) } }),
            unreadable,
        )
        await refused(
            page,
            await patched('skin', { resources: { data: gzOf({ width: 'wide', sprites: [] }) } }),
            unreadable,
        )
        await refused(
            page,
            await patched('skin', {
                resources: {
                    data: new Uint8Array(
                        gzipSync(
                            '{"width":64,"height":64,"sprites":[{"name":"a","x":NaN,"y":0,"w":1,"h":1}]}',
                        ),
                    ),
                },
            }),
            unreadable,
        )
        await refused(
            page,
            await patched('skin', { hashes: 'bad' }),
            'This file’s skin thumbnail does not match its checksum.',
        )
        await refused(
            page,
            await patched('skin', { resources: { texture: pngHeader(8192, 8192) } }),
            'This file’s skin texture is 8192 × 8192; the limit is 4096 × 4096.',
        )
        await refused(
            page,
            await patched('skin', {
                resources: { thumbnail: pngHeader(2000, 2000) },
            }),
            'This file’s skin thumbnail is 2000 × 2000; the limit is 1024 × 1024.',
        )

        // A sprite outside the texture, in the real skin's own data.
        const skinData = jsonOf<SkinData>(await resourceOf('skin', 'data'))
        skinData.sprites.push({
            name: 'Outside',
            x: skinData.width - 1,
            y: 0,
            w: 8,
            h: 8,
            transform: skinData.sprites[0]!.transform,
        })
        await refused(
            page,
            await patched('skin', { resources: { data: gzOf(skinData) } }),
            'This file’s skin data has a sprite outside its texture.',
        )

        // A particle effect over 512 particles.
        await chooser(page).locator('[data-chooser-cancel]').click()
        await tabOf(page, 'particle').click()
        await choose(page)
        const particleData = jsonOf<ParticleData>(await resourceOf('particle', 'data'))
        const effect = particleData.effects[0]!
        effect.groups = [{ particles: effect.groups[0]!.particles, count: 600 }]
        await refused(
            page,
            await patched('particle', { resources: { data: gzOf(particleData) } }),
            `This file’s particle effect "${effect.name}" has more than 512 particles.`,
        )

        // Sound effects without #PERFECT.
        await chooser(page).locator('[data-chooser-cancel]').click()
        await tabOf(page, 'effect').click()
        await choose(page)
        const effectData = jsonOf<EffectData>(await resourceOf('effect', 'data'))
        effectData.clips = effectData.clips.filter(
            (clip: { name: string }) => clip.name !== '#PERFECT',
        )
        await refused(
            page,
            await patched('effect', { resources: { data: gzOf(effectData) } }),
            'This file’s sound effects audio has no usable #PERFECT clip.',
        )
        expect(await stored(page)).toHaveLength(0)
    })

    test('null SRL fields are accepted', async ({ page }) => {
        await start(page)
        await open(page)
        await choose(page)
        await pick(page, 'null-hashes.scp', await patched('skin', { hashes: 'null' }))
        await expect(chooser(page).locator('[data-chooser-error]')).toHaveCount(0)
        await expect(chooser(page).locator('[data-chooser-item]')).toHaveCount(1)
        await chooser(page).locator('[data-chooser-use]').click()
        await expect(chooser(page)).toHaveCount(0)
        expect(await stored(page)).toHaveLength(1)
    })
})

// Every state of the dialog and the chooser, wide and narrow, light and dark.
test.describe('looks', () => {
    for (const theme of ['light', 'dark'] as const)
        for (const [size, viewport] of [
            ['wide', { width: 1600, height: 1000 }],
            ['narrow', { width: 360, height: 740 }],
        ] as const)
            test(`the chooser and the lists, ${size}, in the ${theme} theme`, async ({ page }) => {
                test.setTimeout(90_000)
                await page.setViewportSize(viewport)
                await start(page)
                await page.evaluate((theme) => (window.editorTest.settings.theme = theme), theme)
                await open(page, 'skin')
                const name = (state: string) => `${state}-${size}-${theme}`
                const frame = dialog(page)

                await shot(page, name('sources-start'), frame)
                await choose(page)
                await shot(page, name('chooser-empty'), frame)

                // Reading a file, held so the progress shows.
                await page.evaluate(() => {
                    const original = Blob.prototype.arrayBuffer
                    Blob.prototype.arrayBuffer = async function (this: Blob) {
                        await new Promise((resolve) => setTimeout(resolve, 60_000))
                        return original.call(this)
                    }
                    ;(window as unknown as { restoreBlob: () => void }).restoreBlob = () => {
                        Blob.prototype.arrayBuffer = original
                    }
                })
                await pick(page, 'slow.scp', await variants('skin', [{ name: 'slow' }]))
                await expect(chooser(page).locator('[data-chooser-progress]')).toHaveText(
                    /Reading file…/,
                )
                await shot(page, name('chooser-reading'), frame)
                await page.evaluate(() =>
                    (window as unknown as { restoreBlob: () => void }).restoreBlob(),
                )
                await chooser(page).locator('[data-chooser-cancel]').click()
                await choose(page)

                // A lone item with the other types of its name offered.
                await pick(
                    page,
                    'neon-pack.scp',
                    await collection({
                        skin: [{ name: 'neon', title: 'Neon Skin', author: 'Someone' }],
                        particle: [{ name: 'neon', title: 'Neon Particle' }],
                        effect: [{ name: 'neon', title: 'Neon Sounds' }],
                    }),
                )
                await expect(chooser(page).locator('[data-chooser-also] label')).toHaveCount(2)
                await chooser(page).locator('[data-chooser-also-type="particle"]').check()
                await shot(page, name('chooser-listed-one'), frame)
                await chooser(page).locator('[data-chooser-use]').click()
                await expect(chooser(page)).toHaveCount(0)
                await shot(page, name('sources-stored'), frame)

                // Several items, none selected.
                await choose(page)
                await pick(
                    page,
                    'skins.scp',
                    await variants('skin', [
                        { name: 'a', title: 'First Skin', author: 'Ann' },
                        {
                            name: 'b',
                            title: 'A skin with a very long title that has to be cut somewhere',
                            author: 'Bo',
                        },
                        { name: 'c', title: 'Third Skin', author: 'Cy' },
                    ]),
                )
                await expect(chooser(page).locator('[data-chooser-item]')).toHaveCount(3)
                await shot(page, name('chooser-listed-many'), frame)
                // Using the first leaves Neon Skin stored but not in use.
                await chooser(page).locator('[data-chooser-item="a"]').click()
                await chooser(page).locator('[data-chooser-use]').click()
                await expect(chooser(page)).toHaveCount(0)
                await choose(page)

                await pick(page, 'particles.scp', builtinBytes('particle'))
                await expect(chooser(page).locator('[data-chooser-empty]')).toBeVisible()
                await shot(page, name('chooser-none'), frame)

                await pick(page, 'broken.scp', utf8('not a package'))
                await expect(chooser(page).locator('[data-chooser-error]')).toBeVisible()
                await shot(page, name('chooser-error'), frame)

                await pick(
                    page,
                    'big.scp',
                    await patched('skin', { resources: { texture: pngHeader(8192, 8192) } }),
                )
                await chooser(page).locator('[data-chooser-use]').click()
                await expect(chooser(page).locator('[data-chooser-error]')).toContainText('8192')
                await shot(page, name('chooser-error-size'), frame)
                await chooser(page).locator('[data-chooser-cancel]').click()

                // Working: the sound effects decode slowly, so the progress shows.
                await tabOf(page, 'effect').click()
                await slowDecoding(page, 60_000)
                await choose(page)
                await pick(
                    page,
                    'sounds.scp',
                    await variants('effect', [{ name: 'neon', title: 'Neon Sounds' }]),
                )
                await chooser(page).locator('[data-chooser-use]').click()
                await expect(chooser(page).locator('[data-chooser-progress]')).toBeVisible()
                await shot(page, name('chooser-working'), frame)
                await chooser(page).locator('[data-chooser-cancel]').click()

                // A gone file under its row, with Choose Again.
                await page.evaluate((choice) => {
                    const settings = window.editorTest.settings
                    settings.previewAssets = {
                        ...settings.previewAssets,
                        background: choice as unknown as typeof settings.previewAssets.background,
                    }
                }, nightSky)
                await tabOf(page, 'background').click()
                await expect(dialog(page).locator('[data-asset-choose-again]')).toBeVisible()
                await shot(page, name('sources-file-gone'), frame)

                await tabOf(page, 'stored').click()
                await expect(dialog(page).locator('[data-stored-item]')).toHaveCount(3)
                await shot(page, name('stored'), frame)
                await dialog(page)
                    .locator('[data-stored-item]')
                    .filter({ hasText: 'First Skin' })
                    .locator('[data-stored-remove]')
                    .click()
                await expect(page.locator('dialog[open]').last()).toContainText(
                    'Remove "First Skin"?',
                )
                await shot(page, name('stored-remove'), page.locator('dialog[open]').last())
            })
})

test.describe('narrow', () => {
    test.use({ viewport: { width: 360, height: 740 } })

    test('the chooser and the Stored tab fit 360 px without sideways scrolling', async ({
        page,
    }) => {
        await start(page)
        await open(page)
        await choose(page)
        await pick(
            page,
            'neon.scp',
            await variants('skin', [
                {
                    name: 'neon',
                    title: 'A skin with a very long title that has to be cut somewhere',
                    author: 'An author with a long name',
                },
            ]),
        )
        await expect(chooser(page).locator('[data-chooser-item]')).toHaveCount(1)
        const fits = (target: Locator) =>
            target.evaluate((element) => ({
                scrollWidth: element.scrollWidth,
                clientWidth: element.clientWidth,
            }))
        const chooserWidth = await fits(chooser(page))
        expect(chooserWidth.scrollWidth).toBeLessThanOrEqual(chooserWidth.clientWidth)
        await chooser(page).locator('[data-chooser-use]').click()
        await tabOf(page, 'stored').click()
        const list = await fits(dialog(page).locator('[data-stored-list]'))
        expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth)
        const box = await dialog(page).boundingBox()
        expect(box!.x + box!.width).toBeLessThanOrEqual(360)
    })
})
