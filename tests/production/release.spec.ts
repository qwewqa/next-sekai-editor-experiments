import { expect, test, type Page } from '@playwright/test'
import type { ParticleData, SkinData } from '@sonolus/core'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { noteStyles } from '../../src/chart/noteStyle'
import { parseGzippedJson, parseScp } from '../../src/preview/scp'
import { chart, editorReady, instrumentRendering, seedVersion, stereoWav } from './fixtures'

const siteUrl = new URL(process.env.PRODUCTION_SITE_URL ?? 'https://nse.qwewqa.dev/').href

const frames = (page: Page) =>
    page.evaluate(() => ({
        preview: window.productionSmoke.preview,
        chart: window.productionSmoke.chart,
        overlay: window.productionSmoke.overlay,
    }))

// A form opened automatically closes when a resize moves it out of the panel,
// a few frames after the resize, so let the layout settle before reading it.
const showPreviewSettings = async (page: Page) => {
    const toggle = page.getByRole('button', { name: /^(Show )?Preview Settings$/ })
    const radio = page.getByRole('radio', { name: '16:9', exact: true })
    await expect(async () => {
        await page.waitForTimeout(250)
        if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
        await expect(radio).toBeVisible({ timeout: 1000 })
        await page.waitForTimeout(250)
        await expect(radio).toBeVisible({ timeout: 0 })
    }).toPass()
}

test('Preview Settings open by themselves at first load where they fit', async ({ page }) => {
    await page.addInitScript(seedVersion)
    await page.addInitScript(() => {
        // With Groups and Stages closed, the Preview panel has room for the form.
        localStorage.setItem('sonolus-next-sekai-editor.showGroups', 'false')
        localStorage.setItem('sonolus-next-sekai-editor.showStages', 'false')
    })
    await page.goto('/')
    await editorReady(page)
    await expect(page.locator('.preview-controls')).toBeVisible()
    await expect(
        page.getByRole('button', { name: 'Preview Settings', exact: true }),
    ).toHaveAttribute('aria-expanded', 'true')
})

test('the preview packages are served and answer ranges with 206', async ({ page }) => {
    const manifest = (await (await page.request.get('/release-manifest.json')).json()) as {
        previewAssets: { file: string }[]
    }
    const files = manifest.previewAssets.map((asset) => asset.file)
    expect(files).toEqual(expect.arrayContaining(['resource/skin.scp', 'resource/skin2.scp']))
    for (const file of files) {
        const whole = await page.request.get(`/${file}`, {
            headers: { 'Accept-Encoding': 'identity' },
        })
        expect(whole.status(), file).toBe(200)
        const size = (await whole.body()).length
        // The preview server misreads a suffix range, so the tail is asked for by position, as the reader
        // does when it sees that.
        const tail = await page.request.get(`/${file}`, {
            headers: {
                Range: `bytes=${size - 1024}-${size - 1}`,
                'Accept-Encoding': 'identity',
            },
        })
        expect(tail.status(), file).toBe(206)
        expect(tail.headers()['content-range'], file).toBe(
            `bytes ${size - 1024}-${size - 1}/${size}`,
        )
        expect((await tail.body()).length, file).toBe(1024)
    }
})

test('release assets, preview, chart editing and FFT audio work in the production bundle', async ({
    page,
}, testInfo) => {
    const manifestResponse = await page.request.get('/release-manifest.json')
    expect(manifestResponse.ok()).toBe(true)
    const manifest = (await manifestResponse.json()) as {
        previewAssets: { file: string; source: string }[]
        files: Record<string, string>
    }
    const hasParticles = manifest.previewAssets.some(
        (asset) => asset.file === 'resource/particle.scp',
    )
    const optionalParticle = (url: string) =>
        !hasParticles && new URL(url, siteUrl).pathname.endsWith('/resource/particle.scp')
    const errors: string[] = []
    const requests: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
        if (message.type() === 'error' && !optionalParticle(message.location().url))
            errors.push(message.text())
    })
    page.on('response', (response) => {
        if (
            response.status() >= 400 &&
            !(response.status() === 404 && optionalParticle(response.url()))
        )
            errors.push(`${response.status()} ${response.url()}`)
    })
    page.on('requestfailed', (request) =>
        errors.push(`${request.failure()?.errorText}: ${request.url()}`),
    )
    page.on('request', (request) => requests.push(request.url()))
    await page.addInitScript(instrumentRendering)
    // Its preview counts are of the main thread's drawing, which Parallel Rendering off keeps;
    // csp.spec.ts and browserCompatibility.spec.ts check the preview's worker.
    await page.addInitScript(() =>
        localStorage.setItem('sonolus-next-sekai-editor.previewInWorker', 'false'),
    )
    await page.goto('/')

    await test.step('start the bundled Pixi renderer and distribute its dependency notices', async () => {
        const artifact = JSON.parse(
            await readFile(new URL('../../native/lyon/artifact.json', import.meta.url), 'utf8'),
        ) as { artifact: { sha256: string; bytes: number } }
        const wasmAssets = Object.keys(manifest.files).filter((path) => path.endsWith('.wasm'))
        expect(wasmAssets).toHaveLength(1)
        const wasmAsset = wasmAssets[0]!
        expect(wasmAsset).toMatch(/^assets\/lyon-[\w-]{8,}\.wasm$/)
        expect(manifest.files[wasmAsset]).toBe(artifact.artifact.sha256)
        const wasmResponse = await page.request.get('/' + wasmAsset)
        expect(wasmResponse.ok()).toBe(true)
        const wasmBytes = await wasmResponse.body()
        expect(wasmBytes.length).toBe(artifact.artifact.bytes)
        expect(createHash('sha256').update(wasmBytes).digest('hex')).toBe(artifact.artifact.sha256)
        await expect.poll(async () => (await frames(page)).chart).toBeGreaterThan(0)
        // Native acceleration starts asynchronously and must request only the pinned kernel.
        await expect
            .poll(() =>
                requests
                    .filter((url) => new URL(url).pathname.endsWith('.wasm'))
                    .map((url) => new URL(url).href),
            )
            .toEqual([new URL('/' + wasmAsset, page.url()).href])
        const notices = await page.request.get('/THIRD_PARTY_NOTICES.txt')
        expect(notices.ok()).toBe(true)
        const noticeText = await notices.text()
        expect(noticeText).toContain('pixi.js 8.22.0')
        expect(noticeText).toContain('PixiJS 8.22.0 includes one checked source patch:')
        expect(noticeText).not.toContain('canvaskit-wasm')
        expect(manifest.files['notices/libtess.txt']).toMatch(/^[a-f0-9]{64}$/)
        const tessellator = await page.request.get('/notices/libtess.txt')
        expect(tessellator.ok()).toBe(true)
        const tessellatorText = await tessellator.text()
        expect(tessellatorText).toContain('SGI FREE SOFTWARE LICENSE B')
        expect(tessellatorText).toContain('Copyright 2015, Google Inc.')
    })

    await test.step('published packages contain the supported color resources', async () => {
        // Custom and older skins may intentionally rely on the color fallbacks.
        if (
            !['skins', 'particles'].every((category) =>
                manifest.previewAssets.some(
                    (asset) =>
                        asset.source ===
                        `https://coconut.sonolus.com/next-sekai/sonolus/${category}/coconut-next-sekai-1`,
                ),
            )
        )
            return
        const names = async (name: string, category: string) => {
            const response = await page.request.get(`/resource/${name}.scp`)
            expect(response.ok()).toBe(true)
            const archive = parseScp(Uint8Array.from(await response.body()).buffer)
            const item = archive.getJson<{ items: { data: { url: string } }[] }>(
                `sonolus/${category}/list`,
            )!.items[0]!
            const data = parseGzippedJson<SkinData & ParticleData>(archive.get(item.data.url)!)
            return new Set((name === 'skin' ? data.sprites : data.effects).map(({ name }) => name))
        }
        const skin = await names('skin', 'skins')
        const particle = await names('particle', 'particles')
        for (const style of noteStyles.slice(1)) {
            const color = style.charAt(0).toUpperCase() + style.slice(1)
            for (const name of [
                'Sekai Normal Note Middle',
                'Sekai Damage Slide Connection',
                'Sekai Critical Flick Arrow Down Left 6',
            ]) {
                expect(skin.has(`${name} ${color}`)).toBe(true)
            }
            expect(particle.has(`Sekai Normal Note Circular ${color}`)).toBe(true)
        }
    })

    await test.step('load actual release packages and deployed metadata', async () => {
        await editorReady(page)
        // Groups and Stages, open by default, leave too little room for the form to open itself.
        await showPreviewSettings(page)
        await expect(page.locator('.preview-controls input[type="number"]').first()).toHaveValue(
            '10',
        )
        await expect
            .poll(() => page.evaluate(() => window.productionSmoke.uploads))
            .toBe(hasParticles ? 2 : 1)
        await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', siteUrl)
        await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
            'content',
            new URL('thumbnail.png', siteUrl).href,
        )
        const images = await page.evaluate(async () => {
            const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href
            return await Promise.all(
                [icon, new URL('thumbnail.png', location.href).href].map(async (url) => {
                    const response = await fetch(url)
                    return { status: response.status, type: response.headers.get('content-type') }
                }),
            )
        })
        for (const image of images) {
            expect(image.status).toBe(200)
            expect(image.type).toMatch(/^image\//)
        }
    })

    await test.step('fit all aspect ratios through a viewport resize', async () => {
        for (const size of [
            { width: 1600, height: 1000 },
            { width: 1069, height: 733 },
        ]) {
            await page.setViewportSize(size)
            await showPreviewSettings(page)
            for (const [label, ratio] of [
                ['16:9', 16 / 9],
                ['21:9', 21 / 9],
                ['4:3', 4 / 3],
            ] as const) {
                await page.getByRole('radio', { name: label, exact: true }).check()
                await expect
                    .poll(() =>
                        page.locator('.preview-viewport').evaluate((element) => {
                            const viewport = element as HTMLElement
                            return (
                                Number.parseFloat(viewport.style.width) /
                                Number.parseFloat(viewport.style.height)
                            )
                        }),
                    )
                    .toBeCloseTo(ratio, 4)
            }
        }
        await page.setViewportSize({ width: 1600, height: 1000 })
    })

    await test.step('use preview transport at a mobile viewport size', async () => {
        // A form the user opened stays open over the editor, so close it as a user would.
        await page.getByRole('button', { name: 'Minimize Preview Settings', exact: true }).click()
        await page.setViewportSize({ width: 390, height: 844 })
        // Short previews reveal the playback strip on tap; taller ones keep it below.
        const show = page.getByRole('button', { name: 'Show Playback Controls', exact: true })
        let overlay = false
        // The strip only settles into place a few frames after the resize.
        await expect(async () => {
            await page.waitForTimeout(250)
            if (await show.isVisible()) {
                await show.click()
                overlay = true
            }
            await expect(
                page.getByRole('button', { name: 'Forward 1 ms', exact: true }),
            ).toBeVisible({ timeout: 1000 })
        }).toPass()
        const position = page.locator('[aria-label="Preview Time"]:visible')
        await expect(position).toHaveCount(1)
        await expect(position).toHaveText('00:00.000')
        await page.getByRole('button', { name: 'Forward 1 ms', exact: true }).click()
        await expect(position).toHaveText('00:00.001')
        await page.getByRole('button', { name: 'Back 100 ms', exact: true }).click()
        await expect(position).toHaveText('00:00.000')
        if (overlay) {
            await page.getByRole('button', { name: 'Hide Playback Controls', exact: true }).click({
                position: { x: 12, y: 12 },
            })
        }
        await expect(page.getByRole('button', { name: 'Show Preview Settings' })).toBeVisible()
        await page.setViewportSize({ width: 1600, height: 1000 })
    })

    await test.step('import a chart and real stereo audio through file choosers', async () => {
        const opening = page.waitForEvent('filechooser')
        await page.keyboard.press('o')
        await (
            await opening
        ).setFiles({
            name: 'production.usc',
            mimeType: 'application/json',
            buffer: chart,
        })
        await expect(
            page
                .locator('.notification, .notification-pill')
                .filter({ hasText: 'Imported USC chart' }),
        ).toBeVisible()
        await expect(page.getByRole('dialog')).toHaveCount(0)

        await page.keyboard.press(',')
        const settings = page.getByRole('dialog')
        await expect(settings).toHaveCount(1)
        await settings
            .locator('select')
            .filter({ has: page.locator('option[value="fft"]') })
            .selectOption('fft')
        await page.keyboard.press('Escape')
        await expect(settings).toHaveCount(0)

        await page.keyboard.press('m')
        const modal = page.getByRole('dialog')
        await expect(modal).toHaveCount(1)
        const file = modal.locator('input[type="button"]')
        const choosing = page.waitForEvent('filechooser')
        await file.click()
        await (
            await choosing
        ).setFiles({
            name: 'production-stereo.wav',
            mimeType: 'audio/wav',
            buffer: stereoWav(),
        })
        await expect(file).toHaveValue(/^00:02/)
        await modal.getByRole('button', { name: 'Confirm', exact: true }).click()
        await expect(modal).toHaveCount(0)
        await expect.poll(() => page.evaluate(() => window.productionSmoke.fftTiles)).toBe(1)
        await expect
            .poll(() => page.evaluate(() => window.productionSmoke.fftDraws))
            .toBeGreaterThan(0)
    })

    await test.step('select, edit and export the imported note', async () => {
        const bounds = await page.locator('.editor').boundingBox()
        expect(bounds).not.toBeNull()
        // Preview Follow can pan the timeline during the transport smoke above.
        // Return to its start through real input before using chart coordinates.
        await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
        await page.mouse.wheel(0, 10000)
        // Wait until the scroll easing stops redrawing; slow runners lag behind its 250 ms.
        await expect
            .poll(async () => {
                const before = (await frames(page)).chart
                await page.waitForTimeout(250)
                return (await frames(page)).chart - before
            })
            .toBe(0)
        // The view can rest a few pixels off time zero, as it did on a slow runner, so a click
        // at a computed height can miss the note. A box over most of the pane holds it either way.
        await page.keyboard.press('f')
        await page.mouse.move(bounds!.x + 10, bounds!.y + 30)
        await page.mouse.down()
        await page.mouse.move(
            bounds!.x + bounds!.width - 10,
            bounds!.y + bounds!.height / 2 + 100,
            {
                steps: 10,
            },
        )
        await page.mouse.up()
        const lane = page.getByLabel('Lane', { exact: true })
        await expect(lane).toHaveValue('-1.5')
        await lane.fill('2')
        await lane.press('Tab')
        await expect(lane).toHaveValue('2')
        await page.mouse.click(bounds!.x + bounds!.width - 15, bounds!.y + bounds!.height - 15)

        const downloading = page.waitForEvent('download')
        await page.keyboard.press('Shift+P')
        await page
            .getByRole('dialog', { name: 'Export Level Data', exact: true })
            .getByRole('button', { name: 'Export', exact: true })
            .click()
        const download = await downloading
        const saved = testInfo.outputPath('smoke.leveldata.gz')
        await download.saveAs(saved)
        const level = JSON.parse(gunzipSync(await readFile(saved)).toString()) as {
            entities: { archetype: string; data: { name: string; value?: number }[] }[]
        }
        const notes = level.entities.filter((entity) => /Note$/.test(entity.archetype))
        expect(notes).toHaveLength(1)
        expect(notes[0]!.archetype).toBe('NormalTapNote')
        expect(notes[0]!.data).toEqual(
            expect.arrayContaining([
                { name: '#BEAT', value: 0.25 },
                { name: 'lane', value: 3.5 },
                { name: 'size', value: 1.5 },
            ]),
        )
        await expect(page.getByRole('dialog')).toHaveCount(0)
    })

    await test.step('play, pause and suspend rendering when the window blurs', async () => {
        await page.keyboard.press('Space')
        await expect(page.locator('.preview-controls')).toHaveCount(0)
        const playing = await frames(page)
        await expect.poll(async () => (await frames(page)).preview).toBeGreaterThan(playing.preview)
        await page.keyboard.press('Space')
        await expect(page.locator('.preview-controls')).toHaveCount(1)
        await page.mouse.move(1, 1)
        // Activity labels have a deliberate 500 ms expiry; allow their final draw.
        await page.waitForTimeout(750)
        await showPreviewSettings(page)
        await page.waitForTimeout(750)
        const paused = await frames(page)
        await page.waitForTimeout(300)
        expect(await frames(page)).toEqual(paused)

        // Browser focus events exercise the bundled lifecycle, with no app hooks.
        await page.evaluate(() => {
            Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false })
            window.dispatchEvent(new Event('blur'))
        })
        await expect(page.locator('html')).toHaveAttribute('data-app-inactive', '')
        await page.getByRole('radio', { name: '21:9', exact: true }).check()
        await page.waitForTimeout(150)
        expect(await frames(page)).toEqual(paused)
        await page.evaluate(() => {
            Reflect.deleteProperty(document, 'hasFocus')
            window.dispatchEvent(new Event('focus'))
        })
        await expect(page.locator('html')).not.toHaveAttribute('data-app-inactive')
        await expect.poll(async () => (await frames(page)).preview).toBeGreaterThan(paused.preview)
    })

    // The entire editing/preview workflow must not introduce another kernel request.
    expect(requests.filter((url) => new URL(url).pathname.endsWith('.wasm'))).toEqual([
        new URL(
            '/' + Object.keys(manifest.files).find((path) => path.endsWith('.wasm'))!,
            page.url(),
        ).href,
    ])
    expect(errors, 'browser, console and asset errors').toEqual([])
    expect(requests.some((url) => new URL(url).pathname.startsWith('/src/'))).toBe(false)
    expect(requests.some((url) => new URL(url).pathname === '/resource/skin.scp')).toBe(true)
    expect(requests.some((url) => new URL(url).pathname === '/resource/particle.scp')).toBe(true)
    expect(
        requests.some((url) => /\/resource\/(skin2|effect2)\.scp$/.test(new URL(url).pathname)),
        'Next SEKAI 02 is requested only when chosen',
    ).toBe(false)
    expect(requests.some((url) => new URL(url).pathname === '/resource/effect.scp')).toBe(true)
    expect(requests.some((url) => /\/assets\/bg-.*\.png$/.test(new URL(url).pathname))).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('production.png'), fullPage: true })
})
