import { initWasm, Resvg } from '@resvg/resvg-wasm'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const svgDirectory = new URL('./svg/', import.meta.url)
const wasmPath = createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm')

let ready
const init = () => (ready ??= initWasm(readFileSync(wasmPath)))

const templates = new Map()

/** The text of svg/<name>.svg. */
export function template(name) {
    let text = templates.get(name)
    if (text === undefined) {
        text = readFileSync(new URL(`${name}.svg`, svgDirectory), 'utf8')
        templates.set(name, text)
    }
    return text
}

/** Replaces var(--name) with literal values, since resvg doesn't resolve custom properties. */
export function fill(text, vars = {}) {
    const result = text.replace(/var\(--([a-z]+)\)/g, (_, key) => {
        if (!(key in vars)) throw new Error(`Template variable --${key} is not set`)
        return String(vars[key])
    })
    return result
}

/** Straight alpha from the premultiplied pixels tiny-skia produces. */
export function unpremultiply(pixels) {
    const out = new Uint8Array(pixels.length)
    for (let i = 0; i < pixels.length; i += 4) {
        const a = pixels[i + 3]
        if (a === 0) continue
        out[i + 3] = a
        for (let c = 0; c < 3; c++) {
            const value = a === 255 ? pixels[i + c] : Math.round((pixels[i + c] * 255) / a)
            out[i + c] = Math.min(255, value)
        }
    }
    return out
}

/** Renders SVG text to straight-alpha RGBA; width scales the viewBox, if given. */
export async function renderSvg(text, width) {
    await init()
    const resvg = new Resvg(text, width ? { fitTo: { mode: 'width', value: width } } : {})
    const image = resvg.render()
    const result = { width: image.width, height: image.height, data: unpremultiply(image.pixels) }
    image.free()
    resvg.free()
    return result
}

/** Renders svg/<name>.svg with its variables filled. */
export const renderTemplate = (name, vars, width) => renderSvg(fill(template(name), vars), width)
