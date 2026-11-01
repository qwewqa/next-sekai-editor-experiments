import { test, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'

// The preview combo's raster cost (`npm run perf:combo-raster`), which `perf:preview` cannot
// measure in Node. Each figure is the median and maximum of 20 runs, on the main thread and in a
// worker, in headless Chromium:
// - cold: the first combo after the module loads, which parses the glyphs, makes both canvases,
//   allocates the texture and uploads the label and a number;
// - resize: a new figure height, after the glyphs are parsed (allocation, label and number);
// - count change: one number and its upload, for 1 to 5 digits.
// `NSE_COMBO_SAMPLES` names a JSON file for the figures; they are printed either way.

type Figures = Record<string, { median: number; max: number }>

const FIELD_HEIGHTS = [199, 470, 940, 1080, 1440, 2160, 2880]
const RUNS = 20

/** Runs in the page or a worker; plain JavaScript once compiled. */
const sample = async (origin: string, fieldHeights: number[], runs: number): Promise<Figures> => {
    type ComboType = typeof import('../../src/preview/engine/comboType')
    const load = (query = '') =>
        import(`${origin}/src/preview/engine/comboType.ts${query}`) as Promise<ComboType>
    const { createViewport } = (await import(
        `${origin}/src/preview/engine/layout.ts`
    )) as typeof import('../../src/preview/engine/layout')
    const { createPreviewRenderer } = (await import(
        `${origin}/src/preview/gl.ts`
    )) as typeof import('../../src/preview/gl')
    const renderer = createPreviewRenderer(
        new OffscreenCanvas(16, 16) as unknown as HTMLCanvasElement,
        false,
    )
    const figures: Figures = {}
    const record = (name: string, times: number[]) => {
        times.sort((a, b) => a - b)
        figures[name] = {
            median: (times[(times.length - 1) >> 1]! + times[times.length >> 1]!) / 2,
            max: times.at(-1)!,
        }
    }
    const layoutAt = (type: ComboType, fieldH: number, digits: number) => {
        const width = Math.round((fieldH * 16) / 9)
        const layout = type.comboLayout(width, fieldH, createViewport(width, fieldH), digits)
        return { layout, texture: type.comboTextureLayout(layout, 7) }
    }
    const drawAll = (
        type: ComboType,
        raster: ReturnType<ComboType['createComboRaster']>,
        fieldH: number,
    ) => {
        const { layout, texture } = layoutAt(type, fieldH, 3)
        renderer.reserveTexture(2, texture.width, texture.height)
        const label = raster.label(layout, texture)
        renderer.setTextureRegion(2, texture.label.x, texture.label.y, label)
        label.close()
        const number = raster.number(layout, texture, '417')
        renderer.setTextureRegion(2, texture.number.x, texture.number.y, number)
        number.close()
    }

    let fresh = 0
    for (const fieldH of fieldHeights) {
        const cold: number[] = []
        for (let i = 0; i < runs; i++) {
            const type = await load(`?cold=${fieldH}-${fresh++}`)
            const start = performance.now()
            drawAll(type, type.createComboRaster(), fieldH)
            cold.push(performance.now() - start)
        }
        record(`cold ${fieldH}`, cold)

        const type = await load()
        const raster = type.createComboRaster()
        const resize: number[] = []
        for (let i = 0; i < runs; i++) {
            drawAll(type, raster, fieldH === 470 ? 199 : 470)
            const start = performance.now()
            drawAll(type, raster, fieldH)
            resize.push(performance.now() - start)
        }
        record(`resize ${fieldH}`, resize)

        for (const text of ['7', '47', '417', '4170', '41706']) {
            const { layout, texture } = layoutAt(type, fieldH, text.length)
            const change: number[] = []
            for (let i = 0; i < runs; i++) {
                const start = performance.now()
                const number = raster.number(layout, texture, text)
                renderer.setTextureRegion(2, texture.number.x, texture.number.y, number)
                number.close()
                change.push(performance.now() - start)
            }
            record(`count ${fieldH} ${text.length}`, change)
        }
    }
    renderer.dispose()
    return figures
}

const onMain = (page: Page) =>
    page.evaluate(
        async ({ source, fieldHeights, runs }) => {
            const run = new Function(`return ${source}`)() as typeof sample
            return run(location.origin, fieldHeights, runs)
        },
        { source: sample.toString(), fieldHeights: FIELD_HEIGHTS, runs: RUNS },
    )

const inWorker = (page: Page) =>
    page.evaluate(
        async ({ source, fieldHeights, runs }) => {
            const script = `postMessage(await (${source})(${JSON.stringify(location.origin)}, ${JSON.stringify(fieldHeights)}, ${runs}))`
            const worker = new Worker(
                URL.createObjectURL(new Blob([script], { type: 'text/javascript' })),
                { type: 'module' },
            )
            const figures = await new Promise<Figures>((resolve, reject) => {
                worker.onmessage = (event: MessageEvent<Figures>) => resolve(event.data)
                worker.onerror = (event) => reject(new Error(event.message))
            })
            worker.terminate()
            return figures
        },
        { source: sample.toString(), fieldHeights: FIELD_HEIGHTS, runs: RUNS },
    )

test('combo raster cost', async ({ page }) => {
    test.setTimeout(10 * 60_000)
    await page.goto('/')
    const figures = { main: await onMain(page), worker: await inWorker(page) }
    const format = ({ median, max }: { median: number; max: number }) =>
        `${median.toFixed(2)} / ${max.toFixed(2)}`
    console.log('ms, median / max: main | worker')
    for (const name of Object.keys(figures.main))
        console.log(
            `${name.padEnd(16)} ${format(figures.main[name]!)} | ${format(figures.worker[name]!)}`,
        )
    if (process.env.NSE_COMBO_SAMPLES)
        writeFileSync(process.env.NSE_COMBO_SAMPLES, JSON.stringify(figures, null, 2))
})
