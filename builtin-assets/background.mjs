// The Built-in background: soft colour clouds in the base's hues, a faint mottle and scattered soft
// specks, so camera zoom and pan read at several scales. No lines or shapes. Drawn in units of the
// image's height, so any size renders the same picture; the margins fade to `color`, which fills
// the screen where a zoomed-out camera leaves it bare.

/** The fill around the image, and the colour its margins fade to. */
export const color = '#211f4a'

const hex = (value) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255)

const top = hex('#14173a')
const bottom = hex('#251f4c')
const fill = hex(color)

// [x, y, radius x, radius y, colour, strength], x and y in heights, 16:9 (x from 0 to 16/9).
const clouds = [
    [0.32, 0.82, 0.55, 0.32, '#2f7f9c', 0.4],
    [1.45, 0.8, 0.6, 0.34, '#8a37b8', 0.42],
    [0.88, 0.95, 0.75, 0.3, '#4a2fa8', 0.36],
    [0.36, 0.2, 0.5, 0.3, '#6a2f9a', 0.28],
    [1.42, 0.2, 0.48, 0.28, '#1f6c8c', 0.28],
    [0.95, 0.38, 0.62, 0.22, '#23338a', 0.2],
    [0.55, 0.6, 0.28, 0.2, '#5a3bb0', 0.12],
    [1.3, 0.55, 0.3, 0.2, '#2d5aa8', 0.12],
].map(([x, y, rx, ry, c, s]) => [x, y, rx, ry, hex(c), s])

const speckColors = ['#c9c2ff', '#a9e4ff', '#f0c8ff', '#e8ecff'].map(hex)

/** A seeded generator in [0, 1) (mulberry32). */
const random = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const hash = (x, y, seed) => {
    let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647)
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10)

// Smooth value noise in [0, 1].
const noise = (x, y, seed) => {
    const ix = Math.floor(x)
    const iy = Math.floor(y)
    const fx = fade(x - ix)
    const fy = fade(y - iy)
    const a = hash(ix, iy, seed) + (hash(ix + 1, iy, seed) - hash(ix, iy, seed)) * fx
    const b = hash(ix, iy + 1, seed) + (hash(ix + 1, iy + 1, seed) - hash(ix, iy + 1, seed)) * fx
    return a + (b - a) * fy
}

// Three octaves, from a sixth of the height down to a twenty-fourth, in [-1, 1].
const mottle = (x, y) =>
    ((noise(x * 6, y * 6, 1) - 0.5) * 4 +
        (noise(x * 12, y * 12, 2) - 0.5) * 2 +
        (noise(x * 24, y * 24, 3) - 0.5)) /
    3.5

const smoothstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))

/** Renders the background at the given height (16:9) to straight RGBA. */
export function renderBackground(height) {
    const width = Math.round((height * 16) / 9)
    const unit = 1 / height
    const rgb = new Float32Array(width * height * 3)

    // Gradient, clouds and mottle.
    for (let py = 0; py < height; py++) {
        const y = (py + 0.5) * unit
        const base = top.map((c, i) => c + (bottom[i] - c) * y)
        for (let px = 0; px < width; px++) {
            const x = (px + 0.5) * unit
            const out = [...base]
            for (const [cx, cy, rx, ry, c, s] of clouds) {
                const dx = (x - cx) / rx
                const dy = (y - cy) / ry
                const w = s * Math.exp(-2 * (dx * dx + dy * dy))
                if (w < 1e-4) continue
                for (let i = 0; i < 3; i++) out[i] += (c[i] - out[i]) * w
            }
            const m = 1 + 0.16 * mottle(x, y)
            const at = (py * width + px) * 3
            for (let i = 0; i < 3; i++) rgb[at + i] = out[i] * m
        }
    }

    // Specks: soft round dots of many sizes, clustered by the mottle. Most are small and faint;
    // a few are wide, fainter still.
    const next = random(0x5e4a1)
    for (let k = 0; k < 1800; k++) {
        const x = next() * (width * unit)
        const y = next() * (height * unit)
        const size = next()
        const shade = next()
        const c = speckColors[Math.floor(next() * speckColors.length)]
        if (next() > 0.45 + mottle(x + 3.1, y + 1.7)) continue
        // Radius in heights: 0.0012 to 0.006 for most, 0.008 to 0.03 for one in five.
        const wide = size >= 0.8
        const radius = wide ? 0.008 + 0.022 * ((size - 0.8) / 0.2) ** 2 : 0.0012 * 5 ** (size / 0.8)
        const alpha = wide ? 0.04 + 0.05 * shade : 0.06 + 0.14 * shade * (1 - size)
        const sigma = Math.max(radius * height, 1.2)
        const scale = alpha * Math.min(1, (radius * height) / 1.2) ** 2
        const reach = Math.ceil(sigma * 3)
        const cx = x * height - 0.5
        const cy = y * height - 0.5
        const y0 = Math.max(0, Math.floor(cy) - reach)
        const y1 = Math.min(height - 1, Math.ceil(cy) + reach)
        const x0 = Math.max(0, Math.floor(cx) - reach)
        const x1 = Math.min(width - 1, Math.ceil(cx) + reach)
        for (let py = y0; py <= y1; py++)
            for (let px = x0; px <= x1; px++) {
                const d2 = ((px - cx) ** 2 + (py - cy) ** 2) / (sigma * sigma)
                const w = scale * Math.exp(-0.5 * d2)
                if (w < 1e-4) continue
                const at = (py * width + px) * 3
                for (let i = 0; i < 3; i++) rgb[at + i] += (c[i] - rgb[at + i]) * w
            }
    }

    // The margins fade to the fill along a rounded rectangle.
    const data = new Uint8Array(width * height * 4)
    for (let py = 0; py < height; py++) {
        const v = Math.abs((2 * (py + 0.5)) / height - 1) ** 6
        for (let px = 0; px < width; px++) {
            const u = Math.abs((2 * (px + 0.5)) / width - 1) ** 6
            const e = smoothstep((1 - (u + v) ** (1 / 6)) / 0.25)
            const at = (py * width + px) * 3
            for (let i = 0; i < 3; i++) {
                const value = fill[i] + (rgb[at + i] - fill[i]) * e
                data[(py * width + px) * 4 + i] = Math.max(
                    0,
                    Math.min(255, Math.round(value * 255)),
                )
            }
            data[(py * width + px) * 4 + 3] = 255
        }
    }
    return { width, height, data }
}
