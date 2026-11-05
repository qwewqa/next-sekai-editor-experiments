// The Built-in background: a sparse low-poly mesh over a dark gradient. Large jittered triangles,
// each a flat plane tinted from a ramp running teal, indigo, violet and plum, a little lighter or
// darker than its neighbours and shaded along its own slope, meet at soft edges. A faint
// brightness drift runs across them. The edges and slopes make camera zoom, pan and rotation read,
// and nothing is finer than the soft edges. Round the judgment line the facets keep to indigo and
// violet, away from the notes' hues. The image is square, like the Default, so a 16:9 screen shows
// its middle band. It is drawn in units of that band's height (x from 0 to 16/9, y from 0 to 1 in
// the band, -7/18 to 25/18 over the square), so any size renders the same picture. The margins
// fade to `color`, which fills the screen where a zoomed-out camera leaves it bare.

/** The fill around the image, and the colour its margins fade to. */
export const color = '#211f4a'

const hex = (value) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255)

const top = hex('#14173a')
const bottom = hex('#251f4c')
const fill = hex(color)

/** The colours the facets are tinted with, from one end of the hue field to the other. */
const ramp = ['#22709a', '#33389e', '#6a36aa', '#8a3496'].map(hex)

/** How far each facet is tinted towards its ramp colour. */
const tint = 0.3

// The mesh, in band heights: a triangular lattice of this cell, turned by `angle`, its vertices
// moved by up to `jitter` cells. Edges blend over `feather` (about 24 px at 1920).
const cell = 0.25
const angle = 0.29
const jitter = 0.26
const feather = 0.022

/** Per facet: brightness up to this fraction either way, and the steepest slope across it. */
const facetLight = 0.08
const facetSlope = 0.6

const hash = (x, y, seed) => {
    let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647)
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10)

const directions = Array.from({ length: 16 }, (_, i) => [
    Math.cos((i / 16) * Math.PI * 2),
    Math.sin((i / 16) * Math.PI * 2),
])

const corner = (ix, iy, seed, dx, dy) => {
    const [gx, gy] = directions[Math.floor(hash(ix, iy, seed) * 16)]
    return gx * dx + gy * dy
}

// Gradient noise with a standard deviation of about 0.7.
const noise = (x, y, seed) => {
    const ix = Math.floor(x)
    const iy = Math.floor(y)
    const fx = x - ix
    const fy = y - iy
    const u = fade(fx)
    const v = fade(fy)
    const a = corner(ix, iy, seed, fx, fy)
    const b = corner(ix + 1, iy, seed, fx - 1, fy)
    const c = corner(ix, iy + 1, seed, fx, fy - 1)
    const d = corner(ix + 1, iy + 1, seed, fx - 1, fy - 1)
    const ab = a + (b - a) * u
    const cd = c + (d - c) * u
    return (ab + (cd - ab) * v) * 2.9
}

/**
 * Noise at several wavelengths (in band heights) and weights, divided by the weights' root sum of
 * squares, so its spread stays about that of one layer. Each layer's lattice is turned and
 * shifted by its seed, so no two share axes.
 */
const octaves = (list, seed) => {
    const layers = list.map(([wavelength, weight], k) => {
        const s = seed * 31 + k
        const turn = hash(s, 7, 99) * Math.PI
        return [Math.cos(turn), Math.sin(turn), wavelength, weight, s]
    })
    const norm = Math.sqrt(list.reduce((sum, [, weight]) => sum + weight * weight, 0))
    return (x, y) => {
        let sum = 0
        for (const [c, s, wavelength, weight, layerSeed] of layers)
            sum +=
                weight *
                noise(
                    (c * x - s * y) / wavelength + layerSeed * 17.31,
                    (s * x + c * y) / wavelength - layerSeed * 9.73,
                    layerSeed,
                )
        return sum / norm
    }
}

const hueField = octaves([[1.1, 1]], 704)
const drift = octaves(
    [
        [0.3, 1],
        [0.15, 0.5],
    ],
    706,
)

const smoothstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))

/** Pulls a hue towards `to` by `strength` near (x, y), over an ellipse of radii rx, ry. */
const pull = (h, to, strength, x, y, rx, ry, px, py) => {
    const dx = (px - x) / rx
    const dy = (py - y) / ry
    return h + (to - h) * strength * Math.exp(-(dx * dx + dy * dy))
}

const e1 = [Math.cos(angle) * cell, Math.sin(angle) * cell]
const e2 = [Math.cos(angle + Math.PI / 3) * cell, Math.sin(angle + Math.PI / 3) * cell]
const det = e1[0] * e2[1] - e1[1] * e2[0]

const vertex = (i, j) => {
    const a = (hash(i, j, 705) - 0.5) * 2 * jitter
    const b = (hash(i, j, 706) - 0.5) * 2 * jitter
    return [(i + a) * e1[0] + (j + b) * e2[0], (i + a) * e1[1] + (j + b) * e2[1]]
}

/** A facet: its edges as inward normals [nx, ny, c] (distance nx x + ny y + c), and its look. */
const facet = (points, i, j, k) => {
    const [[x0, y0], [x1, y1], [x2, y2]] = points
    const sign = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0) > 0 ? 1 : -1
    const edges = points.map(([ax, ay], n) => {
        const [bx, by] = points[(n + 1) % 3]
        const length = Math.hypot(bx - ax, by - ay)
        const nx = (-(by - ay) / length) * sign
        const ny = ((bx - ax) / length) * sign
        return [nx, ny, -(nx * ax + ny * ay)]
    })
    const cx = (x0 + x1 + x2) / 3
    const cy = (y0 + y1 + y2) / 3
    const random = (n) => hash(i * 2 + k, j, 0x51 + n)
    // Its hue: the hue field at its centre, nudged per facet; indigo and violet round the
    // judgment line, teal towards the upper right.
    let h = 0.5 + 0.32 * hueField(cx, cy) + 0.12 * (random(0) - 0.5)
    h = pull(h, 0.45, 0.85, 8 / 9, 0.8, 0.75, 0.35, cx, cy)
    h = pull(h, 0.08, 0.8, 1.45, 0.12, 0.45, 0.3, cx, cy)
    const s = Math.min(0.9999, Math.max(0, h)) * (ramp.length - 1)
    const r = Math.floor(s)
    const f = smoothstep(s - r)
    const colour = ramp[r].map((value, n) => value + (ramp[r + 1][n] - value) * f)
    // A plane lit from the upper left: its slope points within about 60 degrees of that.
    const turn = -2.3 + (random(2) - 0.5) * 2.2
    const slope = facetSlope * (0.4 + random(3))
    return {
        edges,
        cx,
        cy,
        colour,
        light: 1 + facetLight * (random(1) - 0.5) * 2,
        gx: Math.cos(turn) * slope,
        gy: Math.sin(turn) * slope,
    }
}

/** Renders the square background at the given side (a multiple of 32) to straight RGBA. */
export function renderBackground(side) {
    if (side % 32) throw new Error(`The background's side is not a multiple of 32: ${side}`)
    const width = side
    // The band's height and its first row, both whole pixels.
    const height = (side * 9) / 16
    const offset = (side * 7) / 32
    const unit = 1 / height
    const data = new Uint8Array(side * side * 4)
    const quads = new Map()
    const quad = (i, j) => {
        const key = i * 100003 + j
        let q = quads.get(key)
        if (!q) {
            const p00 = vertex(i, j)
            const p10 = vertex(i + 1, j)
            const p01 = vertex(i, j + 1)
            const p11 = vertex(i + 1, j + 1)
            q = [facet([p00, p10, p01], i, j, 0), facet([p10, p11, p01], i, j, 1)]
            quads.set(key, q)
        }
        return q
    }
    const sum = [0, 0, 0]

    for (let py = 0; py < side; py++) {
        // Rows count from the band's top; the gradient extrapolates past the band.
        const y = (py - offset + 0.5) * unit
        const v = Math.abs((2 * (py + 0.5)) / side - 1) ** 6
        const ground = top.map((c, i) => c + (bottom[i] - c) * y)
        for (let px = 0; px < width; px++) {
            const x = (px + 0.5) * unit
            // The margins fade to the fill along a rounded square.
            const u = Math.abs((2 * (px + 0.5)) / width - 1) ** 6
            const e = smoothstep((1 - (u + v) ** (1 / 6)) / 0.25)
            const at = (py * width + px) * 4
            data[at + 3] = 255
            if (e === 0) {
                for (let i = 0; i < 3; i++) data[at + i] = Math.round(fill[i] * 255)
                continue
            }
            // Blend the facets round the point by their soft coverage.
            const a = (x * e2[1] - y * e2[0]) / det
            const b = (y * e1[0] - x * e1[1]) / det
            const i0 = Math.floor(a)
            const j0 = Math.floor(b)
            const m = 1 + 0.045 * drift(x, y)
            sum[0] = sum[1] = sum[2] = 0
            let total = 0
            for (let i = i0 - 1; i <= i0 + 1; i++)
                for (let j = j0 - 1; j <= j0 + 1; j++)
                    for (const f of quad(i, j)) {
                        let inside = Infinity
                        for (const [nx, ny, c] of f.edges)
                            inside = Math.min(inside, nx * x + ny * y + c)
                        const w = smoothstep((inside + feather / 2) / feather)
                        if (w <= 0) continue
                        const k = m * f.light * (1 + f.gx * (x - f.cx) + f.gy * (y - f.cy))
                        for (let n = 0; n < 3; n++)
                            sum[n] += w * (ground[n] + (f.colour[n] - ground[n]) * tint) * k
                        total += w
                    }
            for (let n = 0; n < 3; n++) {
                const value = fill[n] + (sum[n] / total - fill[n]) * e
                data[at + n] = Math.max(0, Math.min(255, Math.round(value * 255)))
            }
        }
    }
    return { width, height: side, data }
}
