import { expect, test, type Page } from '@playwright/test'

// The combo's raster on CPU canvases, read back with getImageData: on the main thread and in a
// worker. Both must draw the same bytes. Node has no Path2D, so this runs in Chromium.

type Glyph = {
    character: string
    flatTop: boolean
    flatBottom: boolean
    top: number
    bottom: number
}
type Edges = {
    measuredTop: number
    measuredBottom: number
    nominalTop: number
    nominalBottom: number
}
type Measured = {
    fieldH: number
    glyphs: (Glyph & Edges)[]
    union: { text: string; outside: number }[]
    /** The largest alpha change left of the last digit, and the pixels that change at all. */
    countChange: { outside: number; changed: number }
}
type Result = {
    coverage: { fill: number; outline: number; corner: number }
    sizes: Measured[]
    digest: string
}

const FIELD_HEIGHTS = [199, 470, 657, 1080, 2160, 2880]

/** Runs in the page or the worker, with the app's modules; plain JavaScript once compiled. */
const measure = async (
    type: typeof import('../../src/preview/engine/comboType'),
    glyphs: typeof import('../../src/preview/engine/comboGlyphs'),
    layoutModule: typeof import('../../src/preview/engine/layout'),
    fieldHeights: number[],
): Promise<Result> => {
    const all: Uint8ClampedArray[] = []
    const canvas = (width: number, height: number) => {
        const context = new OffscreenCanvas(width, height).getContext('2d', {
            willReadFrequently: true,
        })!
        return context
    }
    const read = (context: OffscreenCanvasRenderingContext2D) => {
        const data = context.getImageData(0, 0, context.canvas.width, context.canvas.height).data
        all.push(data)
        return data
    }
    const alphaAt = (data: Uint8ClampedArray, width: number, x: number, y: number) =>
        data[(y * width + x) * 4 + 3]!

    // Synthetic shapes through the same raster function, read at the pixel [10, 11] x [10, 11].
    const synthetic = (path: Path2D, outline: number) => {
        const context = canvas(32, 32)
        type.paintPath(context, path, outline, type.COMBO_OUTLINE_COLOR, '#ffffff')
        return alphaAt(read(context), 32, 10, 10)
    }
    const fillUnion = new Path2D()
    fillUnion.rect(10, 10, 0.5, 0.5)
    fillUnion.rect(10.5, 10.5, 0.5, 0.5)
    const outlineUnion = new Path2D()
    outlineUnion.rect(-10, 4, 18.5, 13)
    outlineUnion.rect(12.5, 4, 18, 13)
    // A square turned 45 degrees, one edge on x + y = 20.25 - 2 sqrt 2, its corners far away.
    const c = (20.25 - 2 * Math.SQRT2) / 2
    const along = 20 / Math.SQRT2
    const back = 40 / Math.SQRT2
    const corner = new Path2D()
    corner.moveTo(c + along, c - along)
    corner.lineTo(c - along, c + along)
    corner.lineTo(c - along - back, c + along - back)
    corner.lineTo(c + along - back, c - along - back)
    corner.closePath()
    const coverage = {
        fill: synthetic(fillUnion, 0),
        outline: synthetic(outlineUnion, 2),
        corner: synthetic(corner, 2),
    }

    // The rows a raster's ink covers, by half coverage of the fill, within some columns.
    const inkRows = (
        data: Uint8ClampedArray,
        width: number,
        height: number,
        left: number,
        right: number,
    ) => {
        let top = -1
        let bottom = -1
        for (let y = 0; y < height; y++)
            for (let x = Math.max(0, left); x < Math.min(width, right); x++)
                if (alphaAt(data, width, x, y) >= 128) {
                    if (top < 0) top = y
                    bottom = y + 1
                }
        return { top, bottom }
    }

    const sizes: Measured[] = []
    for (const fieldH of fieldHeights) {
        const width = Math.round((fieldH * 16) / 9)
        const viewport = layoutModule.createViewport(width, fieldH)
        const one = type.comboLayout(width, fieldH, viewport, 1)
        const measured: Measured['glyphs'] = []
        const fillOnly = (path: Path2D, image: { width: number; height: number }) => {
            const context = canvas(image.width, image.height)
            type.paintPath(context, path, 0, '', '#ffffff')
            return read(context)
        }
        for (const [character, glyph] of Object.entries(glyphs.COMBO_DIGITS)) {
            const data = fillOnly(type.numberPath(one, character), one.number)
            const rows = inkRows(data, one.number.width, one.number.height, 0, one.number.width)
            measured.push({
                character,
                flatTop: glyph.flatTop,
                flatBottom: glyph.flatBottom,
                top: one.number.originY - glyph.bounds[3] * one.scale,
                bottom: one.number.originY - glyph.bounds[1] * one.scale,
                measuredTop: rows.top,
                measuredBottom: rows.bottom,
                nominalTop: one.number.originY - one.H,
                nominalBottom: one.number.originY,
            })
        }
        // Each letter of the label, by the columns of its pen and advance.
        const label = fillOnly(type.labelPath(one), one.label)
        const scale = one.labelCap / glyphs.COMBO_FONT.capHeight
        let pen = one.label.originX
        for (const [i, letter] of (['C', 'O', 'M', 'B', 'O'] as const).entries()) {
            const glyph = glyphs.COMBO_LETTERS[letter]
            const rows = inkRows(
                label,
                one.label.width,
                one.label.height,
                Math.floor(pen + glyph.bounds[0] * scale),
                Math.ceil(pen + glyph.bounds[2] * scale),
            )
            if (i < 4)
                measured.push({
                    character: letter,
                    flatTop: glyph.flatTop,
                    flatBottom: glyph.flatBottom,
                    top: one.label.originY - glyph.bounds[3] * scale,
                    bottom: one.label.originY - glyph.bounds[1] * scale,
                    measuredTop: rows.top,
                    measuredBottom: rows.bottom,
                    nominalTop: one.label.originY - one.labelCap,
                    nominalBottom: one.label.originY,
                })
            pen += glyphs.COMBO_FONT.labelAdvances[i]! * scale + 0.3 * one.labelCap
        }

        // Where outlines meet, no pixel outside the fill is darker than one outline.
        const two = type.comboLayout(width, fieldH, viewport, 2)
        const union = ['00', '08', '88'].map((text) => {
            const fill = fillOnly(type.numberPath(two, text), two.number)
            const context = canvas(two.number.width, two.number.height)
            type.paintNumber(context, two, text)
            const full = read(context)
            let outside = 0
            for (let i = 3; i < full.length; i += 4)
                if (!fill[i]) outside = Math.max(outside, full[i]!)
            return { text, outside }
        })

        // 417 and 418 differ only next to the last digit.
        const three = type.comboLayout(width, fieldH, viewport, 3)
        const [a, b] = ['417', '418'].map((text) => {
            const context = canvas(three.number.width, three.number.height)
            type.paintNumber(context, three, text)
            return read(context)
        })
        const margin = Math.ceil(three.numberOutline) + 1
        const lastX = three.number.originX + 2 * three.cell
        const bounds = ['7', '8'].map((digit) => glyphs.COMBO_DIGITS[digit]!.bounds)
        const left = lastX + Math.min(...bounds.map((box) => box[0])) * three.scale - margin
        let outside = 0
        let changed = 0
        for (let i = 3; i < a!.length; i += 4) {
            const change = Math.abs(a![i]! - b![i]!)
            if (!change) continue
            changed++
            if ((i >> 2) % three.number.width < left) outside = Math.max(outside, change)
        }
        sizes.push({ fieldH, glyphs: measured, union, countChange: { outside, changed } })
    }

    let total = 0
    for (const data of all) total += data.length
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const data of all) {
        bytes.set(data, offset)
        offset += data.length
    }
    const hash = await crypto.subtle.digest('SHA-256', bytes)
    const digest = [...new Uint8Array(hash)].map((v) => v.toString(16).padStart(2, '0')).join('')
    return { coverage, sizes, digest }
}

const modules = [
    '/src/preview/engine/comboType.ts',
    '/src/preview/engine/comboGlyphs.ts',
    '/src/preview/engine/layout.ts',
]

const onMain = (page: Page) =>
    page.evaluate(
        async ({ source, modules, fieldHeights }) => {
            const [type, glyphs, layout] = await Promise.all(modules.map((path) => import(path)))
            const run = new Function(`return ${source}`)() as typeof measure
            return run(type, glyphs, layout, fieldHeights)
        },
        { source: measure.toString(), modules, fieldHeights: FIELD_HEIGHTS },
    )

const inWorker = (page: Page) =>
    page.evaluate(
        async ({ source, modules, fieldHeights }) => {
            const urls = modules.map((path) => new URL(path, location.href).href)
            const script = `
                const [type, glyphs, layout] = await Promise.all(${JSON.stringify(urls)}.map((url) => import(url)))
                postMessage(await (${source})(type, glyphs, layout, ${JSON.stringify(fieldHeights)}))
            `
            const worker = new Worker(
                URL.createObjectURL(new Blob([script], { type: 'text/javascript' })),
                { type: 'module' },
            )
            const result = await new Promise<Result>((resolve, reject) => {
                worker.onmessage = (event: MessageEvent<Result>) => resolve(event.data)
                worker.onerror = (event) => reject(new Error(event.message))
            })
            worker.terminate()
            return result
        },
        { source: measure.toString(), modules, fieldHeights: FIELD_HEIGHTS },
    )

test('the combo raster is exact where it must be, and the same in a worker', async ({ page }) => {
    await page.goto('/')
    const main = await onMain(page)
    const worker = await inWorker(page)
    expect(worker.digest).toBe(main.digest)
    expect(worker).toEqual(main)

    // Overlapping shapes in one path are covered once, and a diagonal edge has the expected coverage.
    expect(Math.abs(main.coverage.fill - 128)).toBeLessThanOrEqual(1)
    expect(Math.abs(main.coverage.outline - 184)).toBeLessThanOrEqual(1)
    expect(main.coverage.corner).toBeGreaterThanOrEqual(3)
    expect(main.coverage.corner).toBeLessThanOrEqual(9)

    for (const size of main.sizes) {
        for (const glyph of size.glyphs) {
            const name = `${glyph.character} at field ${size.fieldH}`
            if (glyph.flatTop) expect(glyph.measuredTop, name).toBe(glyph.nominalTop)
            else {
                expect(glyph.measuredTop, name).toBeLessThanOrEqual(glyph.nominalTop)
                expect(Math.abs(glyph.measuredTop - glyph.top), name).toBeLessThanOrEqual(1)
            }
            if (glyph.flatBottom) expect(glyph.measuredBottom, name).toBe(glyph.nominalBottom)
            else {
                expect(glyph.measuredBottom, name).toBeGreaterThanOrEqual(glyph.nominalBottom)
                expect(Math.abs(glyph.measuredBottom - glyph.bottom), name).toBeLessThanOrEqual(1)
            }
        }
        for (const { text, outside } of size.union)
            expect(outside, `${text} at field ${size.fieldH}`).toBeLessThanOrEqual(185)
        expect(size.countChange.changed).toBeGreaterThan(0)
        // Chromium's analytic coverage depends on every edge that crosses a row, so the other
        // digits' edge pixels move by a few levels; their shapes do not.
        expect(size.countChange.outside, `field ${size.fieldH}`).toBeLessThanOrEqual(32)
    }
})
