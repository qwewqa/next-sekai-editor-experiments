import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// The atlas filter of the preview's renderer (docs/rendering.md, "Atlas filtering"). The renderer
// tests draw single sprites with createPreviewRenderer and compare them with the filter computed
// on the CPU from the same texels. In the chromium-worker project they draw in a worker. The
// last tests check that the panel, in either host, and Export Video use the filter that
// `nse.test.previewFilter` names.

type Filter = 'today' | 3 | 4

/** Runs `fn` in the page, or in a dedicated worker in the chromium-worker project. */
const inHost = async <A, R>(page: Page, fn: (arg: A) => Promise<R>, arg: A): Promise<R> => {
    if (test.info().project.name !== 'chromium-worker') return page.evaluate(fn, arg)
    return page.evaluate(
        ({ source, arg }) =>
            new Promise<R>((resolve, reject) => {
                const script = `onmessage = async (event) => {
                    try { postMessage({ value: await (${source})(event.data) }) }
                    catch (error) { postMessage({ error: String((error && error.stack) || error) }) }
                }`
                const url = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }))
                const worker = new Worker(url, { type: 'module' })
                worker.onmessage = ({ data }: MessageEvent<{ value?: R; error?: string }>) => {
                    worker.terminate()
                    URL.revokeObjectURL(url)
                    if (data.error !== undefined) reject(new Error(data.error))
                    else resolve(data.value as R)
                }
                worker.onerror = (event) => {
                    worker.terminate()
                    reject(new Error(event.message))
                }
                worker.postMessage(arg)
            }),
        { source: fn.toString(), arg },
    )
}

/**
 * Draws sprites of one colour, and sprites of noise in red and alpha, each surrounded by a
 * saturated colour of its own, at several scales and orientations, with the 4x4, 3x3 and
 * single-tap renderers. Returns the mismatches with the CPU filter, the isolation and identity
 * checks, and counts of what was checked.
 */
const exactness = async ({ origin, reduced }: { origin: string; reduced: boolean }) => {
    type Rect = { x: number; y: number; w: number; h: number; alpha: number; noise?: boolean }
    type P = { x: number; y: number }
    const { createPreviewRenderer } = (await import(
        `${origin}/src/preview/gl.ts`
    )) as typeof import('../../src/preview/gl')
    const { toSpriteUv } = (await import(
        `${origin}/src/preview/skin.ts`
    )) as typeof import('../../src/preview/skin')
    const { decodeAtlas } = (await import(
        `${origin}/src/preview/decodeAtlas.ts`
    )) as typeof import('../../src/preview/decodeAtlas')

    const N = 256
    const filters: Filter[] = [4, 3, 'today']
    const renderers = filters.map((filter) =>
        createPreviewRenderer(new OffscreenCanvas(N, N), false, filter),
    )
    const sprites = [
        [200, 0, 0],
        [255, 0, 0],
        [120, 0, 0],
    ] as const
    const surrounds = [
        [0, 255, 0],
        [0, 0, 255],
        [0, 255, 255],
    ] as const
    const failures: string[] = []
    const fail = (message: string) => {
        if (failures.length < 20) failures.push(message)
    }
    let compared = 0
    let taps = 0
    let interior = 0

    // The atlas as data rects describe it, and the texels as the GPU holds them.
    const dataWidth = reduced ? 4096 : 64
    const dataHeight = reduced ? 2049 : 64
    const hash = (x: number, y: number) =>
        ((Math.imul(x, 0x9e3779b1) ^ Math.imul(y + 7, 0x85ebca6b)) >>> 0) % 251
    const fill = (data: Uint8ClampedArray, width: number, rect: Rect, color: readonly number[]) => {
        for (let y = Math.floor(rect.y); y < Math.ceil(rect.y + rect.h); y++)
            for (let x = Math.floor(rect.x); x < Math.ceil(rect.x + rect.w); x++) {
                const k = (y * width + x) * 4
                data[k] = rect.noise ? hash(x, y) : color[0]!
                data[k + 1] = color[1]!
                data[k + 2] = color[2]!
                data[k + 3] =
                    rect.noise && rect.alpha < 1
                        ? 64 + (hash(y, x) % 192)
                        : Math.round(rect.alpha * 255)
            }
    }
    const atlasData = (rects: Rect[], index: number) => {
        const data = new Uint8ClampedArray(dataWidth * dataHeight * 4)
        const surround = surrounds[index % surrounds.length]!
        for (let i = 0; i < data.length; i += 4) {
            data[i] = surround[0]
            data[i + 1] = surround[1]
            data[i + 2] = surround[2]
            data[i + 3] = 255
        }
        for (const [i, rect] of rects.entries())
            fill(data, dataWidth, rect, sprites[(index + i) % sprites.length]!)
        return new ImageData(data, dataWidth, dataHeight)
    }
    const upload = async (image: ImageData, interpolation: boolean) => {
        let bitmap: ImageBitmap
        if (reduced) {
            const canvas = new OffscreenCanvas(image.width, image.height)
            canvas.getContext('2d')!.putImageData(image, 0, 0)
            const png = await canvas.convertToBlob({ type: 'image/png' })
            bitmap = await decodeAtlas(new Uint8Array(await png.arrayBuffer()), 2048)
        } else
            bitmap = await createImageBitmap(image, {
                premultiplyAlpha: 'premultiply',
                colorSpaceConversion: 'none',
            })
        for (const renderer of renderers) renderer.setTexture(0, bitmap, interpolation)
        const width = bitmap.width
        const height = bitmap.height
        bitmap.close()
        return { width, height, texels: renderers[0]!.readPixels(0, 0, 0, width, height) }
    }

    const draw = (
        renderer: (typeof renderers)[number],
        sprite: { u0: number; v0: number; u1: number; v1: number },
        quad: { tl: P; tr: P; bl: P; br: P },
    ) => {
        const clip = (p: P) => ({ x: (2 * p.x - N) / N, y: 1 - (2 * p.y) / N })
        renderer.begin(N, N)
        renderer.draw(
            sprite,
            { tl: clip(quad.tl), tr: clip(quad.tr), bl: clip(quad.bl), br: clip(quad.br) },
            [0],
            1,
        )
        renderer.flush()
        return renderer.readPixels('frame', 0, 0, N, N)
    }

    const scales = [0.5, 1, 1.5, 3, 6]
    const orientations = [
        { angle: 0, mirror: false },
        { angle: 30, mirror: false },
        { angle: 90, mirror: false },
        { angle: 30, mirror: true },
    ]
    // Corners on a 1/16-pixel grid, which rasterizers hold exactly, so the GPU interpolates the
    // same parallelogram the CPU does.
    const snap = (value: number) => Math.round(value * 16) / 16
    const quadOf = (rect: Rect, scale: number, angle: number, mirror: boolean) => {
        const c = Math.cos((angle * Math.PI) / 180)
        const s = Math.sin((angle * Math.PI) / 180)
        const w = rect.w / scale
        const h = rect.h / scale
        const ex = { x: snap((mirror ? -w : w) * c), y: snap((mirror ? -w : w) * s) }
        const ey = { x: snap(-h * s), y: snap(h * c) }
        const tl = {
            x: snap(N / 2 + 0.37 - (ex.x + ey.x) / 2),
            y: snap(N / 2 + 0.21 - (ex.y + ey.y) / 2),
        }
        const tr = { x: tl.x + ex.x, y: tl.y + ex.y }
        const bl = { x: tl.x + ey.x, y: tl.y + ey.y }
        return { tl, tr, bl, br: { x: tr.x + ey.x, y: tr.y + ey.y } }
    }

    // The filter of the renderer's fragment shader, on the CPU, from the texels read back.
    const texel = (
        t: { width: number; height: number; texels: Uint8Array },
        x: number,
        y: number,
    ) =>
        (Math.min(Math.max(y, 0), t.height - 1) * t.width + Math.min(Math.max(x, 0), t.width - 1)) *
        4
    const bilinear = (
        t: { width: number; height: number; texels: Uint8Array },
        u: number,
        v: number,
        out: number[],
    ) => {
        const x = u * t.width - 0.5
        const y = v * t.height - 0.5
        const x0 = Math.floor(x)
        const y0 = Math.floor(y)
        const fx = x - x0
        const fy = y - y0
        const a = texel(t, x0, y0)
        const b = texel(t, x0 + 1, y0)
        const c = texel(t, x0, y0 + 1)
        const d = texel(t, x0 + 1, y0 + 1)
        for (let i = 0; i < 4; i++)
            out[i]! +=
                (t.texels[a + i]! * (1 - fx) + t.texels[b + i]! * fx) * (1 - fy) +
                (t.texels[c + i]! * (1 - fx) + t.texels[d + i]! * fx) * fy
    }
    const cpuFilter = (
        t: { width: number; height: number; texels: Uint8Array },
        cap: number,
        box: { u0: number; v0: number; u1: number; v1: number },
        u: number,
        v: number,
        dx: P,
        dy: P,
    ) => {
        const out = [0, 0, 0, 0]
        const lx = Math.hypot(dx.x * t.width, dx.y * t.height)
        const ly = Math.hypot(dy.x * t.width, dy.y * t.height)
        if (cap === 0 || box.u1 < box.u0 || box.v1 < box.v0 || Math.max(lx, ly) <= 1) {
            bilinear(t, u, v, out)
            return out
        }
        const nx = lx > 1 ? cap : 1
        const ny = ly > 1 ? cap : 1
        const kx = nx > 1 ? (lx - 1) / lx : 0
        const ky = ny > 1 ? (ly - 1) / ly : 0
        for (let i = 0; i < nx; i++) {
            const fx = nx > 1 ? i / (nx - 1) - 0.5 : 0
            for (let j = 0; j < ny; j++) {
                const fy = ny > 1 ? j / (ny - 1) - 0.5 : 0
                const tu = Math.min(Math.max(u + dx.x * kx * fx + dy.x * ky * fy, box.u0), box.u1)
                const tv = Math.min(Math.max(v + dx.y * kx * fx + dy.y * ky * fy, box.v0), box.v1)
                // Sampling support: every tap lies inside the sprite's UV box.
                if (tu < box.u0 || tu > box.u1 || tv < box.v0 || tv > box.v1)
                    fail(`tap ${tu}, ${tv} outside the box ${JSON.stringify(box)}`)
                taps++
                bilinear(t, tu, tv, out)
            }
        }
        for (let i = 0; i < 4; i++) out[i]! /= nx * ny
        return out
    }

    const check = (
        t: { width: number; height: number; texels: Uint8Array },
        rect: Rect,
        isolated: boolean,
        label: string,
        interpolation = true,
    ) => {
        const box = toSpriteUv(rect.x, rect.y, rect.w, rect.h, dataWidth, dataHeight)
        // The sprite's own colour as the GPU holds it, at its first texel.
        const own = t.texels.slice(
            texel(t, Math.floor(box.u0 * t.width), Math.floor(box.v0 * t.height)),
        )
        for (const scale of scales)
            for (const { angle, mirror } of orientations) {
                const quad = quadOf(rect, scale, angle, mirror)
                const frames = renderers.map((renderer) => draw(renderer, box, quad))
                const where = `${label} ${JSON.stringify(rect)} at ${scale} texels a pixel, ${angle} degrees${mirror ? ' mirrored' : ''}`
                // Magnified and unscaled sprites, and pixel-art atlases, draw as with one tap.
                if (scale <= 1 || !interpolation)
                    for (const [i, frame] of frames.entries())
                        if (frame.some((value, k) => value !== frames[2]![k]))
                            fail(`${where}: filter ${filters[i]} differs from one tap`)
                if (!interpolation) continue
                // Pixel to quad coordinates (a along tl->tr, b along tl->bl), and the UV steps of
                // one pixel along x and y.
                const ex = { x: quad.tr.x - quad.tl.x, y: quad.tr.y - quad.tl.y }
                const ey = { x: quad.bl.x - quad.tl.x, y: quad.bl.y - quad.tl.y }
                const det = ex.x * ey.y - ex.y * ey.x
                if (Math.abs(det) < 1e-9) continue
                const inv = [ey.y / det, -ey.x / det, -ex.y / det, ex.x / det] as const
                const du = box.u1 - box.u0
                const dv = box.v1 - box.v0
                const dx = { x: du * inv[0], y: dv * inv[2] }
                const dy = { x: du * inv[1], y: dv * inv[3] }
                const lengthX = Math.hypot(ex.x, ex.y)
                const lengthY = Math.hypot(ey.x, ey.y)
                for (let py = 0; py < N; py++)
                    for (let px = 0; px < N; px++) {
                        const qx = px + 0.5 - quad.tl.x
                        const qy = py + 0.5 - quad.tl.y
                        const a = inv[0] * qx + inv[1] * qy
                        const b = inv[2] * qx + inv[3] * qy
                        const area = Math.abs(det)
                        // Distance in pixels from the quad's nearest edge, negative outside.
                        const margin = Math.min(
                            (a * area) / lengthY,
                            ((1 - a) * area) / lengthY,
                            (b * area) / lengthX,
                            ((1 - b) * area) / lengthX,
                        )
                        const k = (py * N + px) * 4
                        for (const [i, frame] of frames.entries()) {
                            // Isolation: the surrounding colour never reaches the screen.
                            if (isolated && (frame[k + 1] !== 0 || frame[k + 2] !== 0))
                                fail(
                                    `${where}: filter ${filters[i]} shows the surround at ${px}, ${py}`,
                                )
                            if (margin < -0.01) {
                                if (frame[k + 3] !== 0)
                                    fail(
                                        `${where}: filter ${filters[i]} draws outside at ${px}, ${py}`,
                                    )
                                continue
                            }
                            if (margin < 0.01) continue
                            const cap = filters[i] === 'today' ? 0 : (filters[i] as number)
                            const u = box.u0 + a * du
                            const v = box.v0 + b * dv
                            const expected = cpuFilter(t, cap, box, u, v, dx, dy)
                            compared++
                            for (let c = 0; c < 4; c++)
                                if (Math.abs(frame[k + c]! - expected[c]!) > 1) {
                                    fail(
                                        `${where}: filter ${filters[i]} at ${px}, ${py} channel ${c}: ${frame[k + c]} against ${expected[c]!.toFixed(2)} on the CPU`,
                                    )
                                    break
                                }
                            // At least a pixel inside, an integer rect at full size shows only its
                            // own colour.
                            if (isolated && !rect.noise && margin >= 1) {
                                interior++
                                for (let c = 0; c < 4; c++)
                                    if (Math.abs(frame[k + c]! - own[c]!) > 1) {
                                        fail(
                                            `${where}: filter ${filters[i]} at ${px}, ${py} is ${[...frame.slice(k, k + 4)].join(', ')}, not the sprite's ${[...own.slice(0, 4)].join(', ')}`,
                                        )
                                        break
                                    }
                            }
                        }
                    }
            }
    }

    if (reduced) {
        // 4096x2049 decoded under a 2048 limit: 2048x1024, so X and Y scale differently.
        const rects: Rect[] = [
            { x: 0, y: 0, w: 64, h: 64, alpha: 1 },
            { x: 4093, y: 0, w: 3, h: 3, alpha: 0.5 },
            { x: 0, y: 2048, w: 1, h: 1, alpha: 1 },
            { x: 4032, y: 1985, w: 64, h: 64, alpha: 0.5 },
            { x: 1001, y: 999, w: 3, h: 3, alpha: 1 },
            { x: 2001, y: 501, w: 1, h: 3, alpha: 0.5 },
            { x: 3001, y: 1501, w: 64, h: 1, alpha: 1 },
            { x: 101, y: 1201, w: 0.5, h: 3, alpha: 1 },
            { x: 200.5, y: 300.25, w: 1.5, h: 1.5, alpha: 0.5 },
            { x: 517, y: 611, w: 100, h: 60, alpha: 0.5, noise: true },
        ]
        const t = await upload(atlasData(rects, 0), true)
        if (t.width !== 2048 || t.height !== 1024) fail(`decoded at ${t.width}x${t.height}`)
        for (const rect of rects) check(t, rect, false, 'reduced')
    } else {
        const integer: Rect[] = [
            { x: 0, y: 0, w: 1, h: 1, alpha: 1 },
            { x: 63, y: 0, w: 1, h: 1, alpha: 0.5 },
            { x: 0, y: 61, w: 3, h: 3, alpha: 1 },
            { x: 61, y: 61, w: 3, h: 3, alpha: 0.5 },
            { x: 61, y: 0, w: 3, h: 3, alpha: 1 },
            { x: 30, y: 20, w: 3, h: 3, alpha: 1 },
            { x: 0, y: 0, w: 64, h: 64, alpha: 0.5 },
            { x: 0, y: 10, w: 64, h: 3, alpha: 1 },
            { x: 20, y: 0, w: 1, h: 64, alpha: 0.5 },
            { x: 3, y: 5, w: 50, h: 37, alpha: 1, noise: true },
            { x: 10, y: 20, w: 40, h: 30, alpha: 0.5, noise: true },
        ]
        const fractional: Rect[] = [
            { x: 1, y: 7, w: 0.5, h: 3, alpha: 1 },
            { x: 20.5, y: 30.25, w: 1.5, h: 1.5, alpha: 0.5 },
        ]
        for (const [index, rect] of [...integer, ...fractional].entries()) {
            const t = await upload(atlasData([rect], index), true)
            check(t, rect, index < integer.length, 'full size')
        }
        // Pixel-art atlases keep nearest sampling and a single tap.
        for (const [index, rect] of integer.slice(5).entries()) {
            const t = await upload(atlasData([rect], index), false)
            check(t, rect, false, 'pixel art', false)
        }
    }
    for (const renderer of renderers) renderer.dispose()
    return { failures, compared, taps, interior }
}

/**
 * A 64x64 pattern (isolated bright texels every 3 texels, a 1-texel line each way) drawn once a
 * frame on a 128x128 frame with antialiasing, as a scale sweep from 0.8 to 4.4 texels a pixel
 * or, with `shear`, at 3 texels a pixel with the quad's shear swept from -shear to +shear.
 * Returns, per frame, the RMS over pixels of the first and second differences in time.
 */
const sweep = async (o: {
    origin: string
    filter: Filter
    angle: number
    mirror: boolean
    frames: number
    shear?: number
}) => {
    const { createPreviewRenderer } = (await import(
        `${o.origin}/src/preview/gl.ts`
    )) as typeof import('../../src/preview/gl')
    const { toSpriteUv } = (await import(
        `${o.origin}/src/preview/skin.ts`
    )) as typeof import('../../src/preview/skin')
    const N = 128
    const T = 64
    const renderer = createPreviewRenderer(new OffscreenCanvas(N, N), true, o.filter)
    const data = new Uint8ClampedArray(T * T * 4)
    for (let j = 0; j < T; j++)
        for (let i = 0; i < T; i++) {
            const on = (i % 3 === 1 && j % 3 === 1) || i === 40 || j === 20
            const k = (j * T + i) * 4
            data[k] = data[k + 1] = data[k + 2] = on ? 255 : 0
            data[k + 3] = 255
        }
    const bitmap = await createImageBitmap(new ImageData(data, T, T), {
        premultiplyAlpha: 'premultiply',
    })
    renderer.setTexture(0, bitmap, true)
    bitmap.close()
    renderer.setRenderTarget({ width: N, height: N, antialias: true })
    const sprite = { ...toSpriteUv(0, 0, T, T, T, T), texture: 0 as const }
    const c = Math.cos((o.angle * Math.PI) / 180)
    const sn = Math.sin((o.angle * Math.PI) / 180)
    const at = (x: number, y: number) => {
        const mx = o.mirror ? -x : x
        return { x: mx * c - y * sn + 0.0013, y: mx * sn + y * c + 0.0007 }
    }
    const first: number[] = []
    const second: number[] = []
    let previous: Float32Array | undefined
    let before: Float32Array | undefined
    for (let k = 0; k < o.frames; k++) {
        const t = k / (o.frames - 1)
        const shear = o.shear ? -o.shear + 2 * o.shear * t : 0
        const scale = o.shear ? 3 : 0.8 + (4.4 - 0.8) * t
        // Half extents in clip units: the sprite is T / scale pixels, and a pixel 2 / N units.
        const hw = T / scale / N
        const hh = T / scale / N
        const sx = shear * hh
        renderer.begin(N, N, 1)
        renderer.draw(
            sprite,
            {
                bl: at(-hw - sx, -hh),
                tl: at(-hw + sx, hh),
                tr: at(hw + sx, hh),
                br: at(hw - sx, -hh),
            },
            [1],
            1,
        )
        renderer.flush()
        const pixels = renderer.readPixels('frame', 0, 0, N, N)
        const grey = new Float32Array(N * N)
        for (let i = 0; i < N * N; i++)
            grey[i] = Math.round((pixels[i * 4]! + pixels[i * 4 + 1]! + pixels[i * 4 + 2]!) / 3)
        if (previous) {
            let sum = 0
            for (let i = 0; i < N * N; i++) sum += (grey[i]! - previous[i]!) ** 2
            first.push(Math.sqrt(sum / (N * N)))
        }
        if (previous && before) {
            let sum = 0
            for (let i = 0; i < N * N; i++) sum += (grey[i]! - 2 * previous[i]! + before[i]!) ** 2
            second.push(Math.sqrt(sum / (N * N)))
        }
        before = previous
        previous = grey
    }
    renderer.dispose()
    return { first, second }
}

const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b)
    const middle = sorted.length / 2
    return sorted.length % 2
        ? sorted[Math.floor(middle)]!
        : (sorted[middle - 1]! + sorted[middle]!) / 2
}

test.describe('the renderer', () => {
    test.beforeEach(async ({ page }) => {
        await page.route('**/__preview-filter', (route) =>
            route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }),
        )
        await page.goto('/__preview-filter')
    })

    for (const reduced of [false, true])
        test(`matches the filter computed on the CPU on ${reduced ? 'a reduced decode' : 'a full-size atlas'}`, async ({
            page,
            baseURL,
        }) => {
            test.setTimeout(120_000)
            const result = await inHost(page, exactness, { origin: baseURL!, reduced })
            expect(result.failures).toEqual([])
            expect(result.compared).toBeGreaterThan(reduced ? 20_000 : 100_000)
            expect(result.taps).toBeGreaterThan(100_000)
            if (!reduced) expect(result.interior).toBeGreaterThan(10_000)
        })

    for (const [name, angle, mirror] of [
        ['0 degrees', 0, false],
        ['30 degrees', 30, false],
        ['30 degrees mirrored', 30, true],
        ['90 degrees', 90, false],
    ] as const)
        test(`a scale sweep at ${name} has no jump at the tap thresholds and flickers less than one tap`, async ({
            page,
            baseURL,
        }) => {
            test.setTimeout(120_000)
            const frames = 720
            const scales = Array.from({ length: frames }, (_, k) => 0.8 + (3.6 * k) / (frames - 1))
            // The second difference at frame k + 1.
            const at = scales.slice(1, -1)
            const results: Record<string, { second: number[] }> = {}
            for (const filter of ['today', 4, 3] as const)
                results[filter] = await inHost(page, sweep, {
                    origin: baseURL!,
                    filter,
                    angle,
                    mirror,
                    frames,
                })
            const steady = (second: number[]) => median(second.filter((_, k) => at[k]! > 1.02))
            for (const filter of [4, 3] as const) {
                const { second } = results[filter]!
                for (const threshold of [1, 2, 3, 4]) {
                    const near = second.filter((_, k) => Math.abs(at[k]! - threshold) < 0.02)
                    const around = second.filter(
                        (_, k) =>
                            Math.abs(at[k]! - threshold) < 0.3 &&
                            Math.abs(at[k]! - threshold) >= 0.02,
                    )
                    expect(
                        Math.max(...near) / median(around),
                        `${filter} taps at ${threshold} texels a pixel`,
                    ).toBeLessThanOrEqual(3)
                }
                expect(steady(second), `${filter} taps`).toBeLessThan(steady(results.today!.second))
            }
        })

    for (const [name, angle] of [
        ['0 degrees', 0],
        ['30 degrees', 30],
    ] as const)
        test(`a shear sweep through zero at ${name} changes as smoothly as elsewhere`, async ({
            page,
            baseURL,
        }) => {
            test.setTimeout(120_000)
            const frames = 600
            // The default, 4x4. 3x3 changes about as much at zero, but less elsewhere at 0 degrees,
            // so its ratio is higher.
            const { first } = await inHost(page, sweep, {
                origin: baseURL!,
                filter: 4,
                angle,
                mirror: false,
                frames,
                shear: 0.3,
            })
            const middle = (k: number) => Math.abs(k - (frames - 2) / 2) < frames * 0.01
            const jump = Math.max(...first.filter((_, k) => middle(k)))
            expect(jump / median(first.filter((_, k) => !middle(k)))).toBeLessThanOrEqual(3)
        })
})

test.describe('the hosts', () => {
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem(
                'sonolus-next-sekai-editor.previewAssets',
                JSON.stringify(
                    Object.fromEntries(
                        ['skin', 'particle', 'background', 'effect'].map((type) => [
                            type,
                            { source: 'builtin' },
                        ]),
                    ),
                ),
            )
        })
        await page.addInitScript(installCanvasCounters)
        await page.goto('/')
    })

    /** Opens the editor again with `filter` in the test key, or without the key. */
    const reopen = async (page: Page, filter: string | undefined) => {
        await page.evaluate((filter) => {
            if (filter === undefined) localStorage.removeItem('nse.test.previewFilter')
            else localStorage.setItem('nse.test.previewFilter', filter)
        }, filter)
        await page.reload()
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await page.evaluate(installEditorFixture)
    }

    test('the panel draws with the filter the test key names', async ({ page }, testInfo) => {
        const host = testInfo.project.name === 'chromium-worker' ? 'worker' : 'main'
        const shots: Buffer[] = []
        for (const filter of [undefined, '3', 'today']) {
            await reopen(page, filter)
            await page.evaluate(() => {
                const { settings, show, fixtures, view } = window.editorTest
                settings.showPreview = true
                settings.previewShowEffects = false
                settings.previewShowTime = false
                settings.previewControls = 'collapsed'
                show(fixtures.notes, 0)
                view.cursorTime = 1
            })
            const viewport = page.locator('.preview-viewport').first()
            await expect(viewport.locator('canvas').first()).toBeVisible()
            await expect.poll(() => page.evaluate(() => window.nsePreviewTest?.host)).toBe(host)
            for (let i = 0; i < 2; i++)
                await page.evaluate(async () => {
                    await window.editorTest.nextTick()
                    await new Promise<void>((resolve) =>
                        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                    )
                    await window.nsePreviewTest?.settled()
                })
            await page.waitForTimeout(400)
            shots.push(await viewport.screenshot({ animations: 'disabled' }))
        }
        // 4x4, 3x3 and one tap each draw the minified notes differently.
        expect(shots[0]!.equals(shots[1]!)).toBe(false)
        expect(shots[0]!.equals(shots[2]!)).toBe(false)
        expect(shots[1]!.equals(shots[2]!)).toBe(false)
    })

    for (const filter of ['3', 'today'])
        test(`Export Video draws with the filter the test key names: ${filter}`, async ({
            page,
        }, testInfo) => {
            test.skip(
                testInfo.project.name === 'chromium-worker',
                'Export Video has its own worker',
            )
            await reopen(page, filter)
            await page.evaluate(() => window.editorTest.show(window.editorTest.fixtures.notes))
            // The reference is drawn on the main thread with the filter the key names.
            const result = await page.evaluate(() =>
                window.editorTest.exportVideo({ parityAt: 0, settings: { frames: 3 } }),
            )
            expect(result.error).toBeUndefined()
            expect(result.phase).toBe('ready')
            expect(result.maxError).toBe(0)
        })
})
