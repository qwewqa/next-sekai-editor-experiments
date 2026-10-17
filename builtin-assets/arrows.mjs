// Flick arrow art, drawn per direction and width in the engine's arrow square (side 1, y up from
// its bottom edge) so the shapes land undistorted: a filled, notched arrowhead with a light rim and
// a soft glow. Sizes follow the base skin's arrows (Next SEKAI 01): where each lands and how much
// of it is inked, measured in the same square.

// The base's up and down arrows by width (1 to 6): [u0, u1, v0, v1] of what they ink.
const upBoxes = [
    [-0.14, 1.14, 0.25, 1.61],
    [-0.09, 1.09, 0.17, 1.21],
    [-0.07, 1.07, 0.11, 0.94],
    [-0.05, 1.05, 0.09, 0.79],
    [-0.04, 1.04, 0.07, 0.7],
    [-0.03, 1.03, 0.06, 0.64],
]
// The base's down arrows sit a little lower.
const downDrop = [0.07, 0.06, 0.04, 0.04, 0.03, 0.03]
// The base's up-left arrows, [u0, u1, v0, v1]; its down-left ones sit a little lower.
const diagonalBoxes = [
    [-0.32, 1.32, 0.27, 1.66],
    [-0.24, 1.21, 0.2, 1.27],
    [-0.19, 1.15, 0.15, 1.03],
    [-0.17, 1.12, 0.11, 0.89],
    [-0.15, 1.1, 0.08, 0.81],
    [-0.13, 1.09, 0.07, 0.75],
]
const diagonalDrop = [0.11, 0.09, 0.08, 0.06, 0.04, 0.04]

// The arms' thickness as a share of the height: a notched "house" on narrow notes (the notch
// about 36% of the height), a chevron with arms at least 45% of it on wide ones. Area = W x S, the
// base's inked area.
const armShare = [0.64, 0.62, 0.58, 0.52, 0.48, 0.46]
// Diagonals turn an arrowhead towards the flick, less on wide notes, and its size is solved so the
// turned shape fills the base's box: the same proportions on screen. Turned shapes are flatter, so
// their arms take more of the height to ink as much.
const turn = [22, 18, 14, 12, 10, 10].map((degrees) => (degrees * Math.PI) / 180)
const diagonalShare = [0.66, 0.62, 0.58, 0.55, 0.5, 0.47]
// Texture pixels per unit of the square: narrow arrows draw small, wide ones large.
const density = [60, 84, 104, 120, 136, 150]

const round = (value) => Math.round(value * 1000) / 1000

/** The outline of an up arrow W wide and H high, its base on y = 0 and centred on x = 0. */
function upOutline(w, h, s) {
    const n = h - s
    return [
        [-w / 2, 0],
        [0, n],
        [w / 2, 0],
        [w / 2, s],
        [0, h],
        [-w / 2, s],
    ]
}

const signedArea = (points) =>
    points.reduce((sum, [x, y], i) => {
        const [nx, ny] = points[(i + 1) % points.length]
        return sum + x * ny - nx * y
    }, 0) / 2

/** The polygon moved inwards by d along every edge (a simple polygon, d small). */
export function inset(points, d) {
    const sign = signedArea(points) > 0 ? 1 : -1
    const lines = points.map(([x, y], i) => {
        const [nx, ny] = points[(i + 1) % points.length]
        const length = Math.hypot(nx - x, ny - y)
        // Inward normal: left of the edge for a counter-clockwise outline.
        const [ox, oy] = [(-(ny - y) / length) * d * sign, ((nx - x) / length) * d * sign]
        return { x: x + ox, y: y + oy, dx: nx - x, dy: ny - y }
    })
    return lines.map((line, i) => {
        const previous = lines[(i + lines.length - 1) % lines.length]
        const cross = previous.dx * line.dy - previous.dy * line.dx
        const t = ((line.x - previous.x) * line.dy - (line.y - previous.y) * line.dx) / cross
        return [previous.x + previous.dx * t, previous.y + previous.dy * t]
    })
}

const turnBy = (points, angle) =>
    points.map(([x, y]) => [
        x * Math.cos(angle) - y * Math.sin(angle),
        x * Math.sin(angle) + y * Math.cos(angle),
    ])
const bounds = (points) => {
    const xs = points.map(([x]) => x)
    const ys = points.map(([, y]) => y)
    return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
}

/**
 * The outline of the arrow for a direction (up, upLeft, down, downLeft) and width (1 to 6) in the
 * arrow square, with the point its tip is at and the middle of its base.
 */
export function arrowOutline(direction, width) {
    const diagonal = direction === 'upLeft' || direction === 'downLeft'
    const [u0, u1, v0, v1] = (diagonal ? diagonalBoxes : upBoxes)[width - 1]
    const angle = diagonal ? turn[width - 1] : 0
    const share = (diagonal ? diagonalShare : armShare)[width - 1]
    const shape = (w, h) => {
        const turned = (list) =>
            turnBy(
                list.map(([x, y]) => [x, y - h / 2]),
                angle,
            )
        return [
            turned(upOutline(w, h, share * h)),
            ...turned([
                [0, h],
                [0, 0],
            ]),
        ]
    }
    // The W and H whose turned outline has the box's bounds (a few rounds converge).
    let [w, h] = [u1 - u0, v1 - v0]
    for (let round = 0; round < (diagonal ? 30 : 0); round++) {
        const [x0, x1, y0, y1] = bounds(shape(w, h)[0])
        ;[w, h] = [(w * (u1 - u0)) / (x1 - x0), (h * (v1 - v0)) / (y1 - y0)]
    }
    let [points, tip, tail] = shape(w, h)
    if (direction === 'down' || direction === 'downLeft') {
        const flip = ([x, y]) => [x, -y]
        ;[points, tip, tail] = [points.map(flip), flip(tip), flip(tail)]
    }
    // Place on the base's box, down arrows lower.
    const [x0, , y0] = bounds(points)
    const drop =
        direction === 'down' ? downDrop : direction === 'downLeft' ? diagonalDrop : undefined
    const bottom = v0 - (drop ? drop[width - 1] : 0)
    const place = ([x, y]) => [x - x0 + u0, y - y0 + bottom]
    return { points: points.map(place), tip: place(tip), tail: place(tail) }
}

// The frame moved up by shift and turned upside down.
const flipped = ([u0, u1, v0, v1], shift) => [u0, u1, v1 + shift, v0 + shift]

/**
 * The sprite of an arrow: template variables, the texture width and the frame [u0, u1, v0, v1] in
 * the arrow square that the texture covers. Down arrows are their up arrow's art, flipped by the
 * frame (v0 above v1), so the two share a texture.
 */
export function arrowSprite(direction, width, { accent, rim, tip }) {
    const down = direction === 'down' || direction === 'downLeft'
    const up = down ? (direction === 'down' ? 'up' : 'upLeft') : direction
    const { points, tip: tipAt, tail } = arrowOutline(up, width)
    const [x0, x1, y0, y1] = bounds(points)
    // Rim, rounding and glow in square units: about 2 pixels of rim at the judge line.
    const rimWidth = 0.05 / Math.sqrt(width)
    const rounding = 0.6 * rimWidth
    const glow = 0.025 + 0.003 * width
    const margin = glow + 0.01
    const frame = [x0 - margin, x1 + margin, y0 - margin, y1 + margin]
    const scale = 100
    // SVG units: x right, y down from the frame's top-left.
    const svg = ([x, y]) => [round((x - frame[0]) * scale), round((frame[3] - y) * scale)]
    const list = (polygon) =>
        polygon
            .map(svg)
            .map((point) => point.join(','))
            .join(' ')
    const [vw, vh] = [(frame[1] - frame[0]) * scale, (frame[3] - frame[2]) * scale]
    const [ax, ay] = svg(tipAt)
    const [bx, by] = svg(tail)
    return {
        vars: {
            view: `0 0 ${round(vw)} ${round(vh)}`,
            glow: list(points),
            outer: list(inset(points, rounding)),
            inner: list(inset(points, rounding + rimWidth)),
            round: round(2 * rounding * scale),
            // A glow in two flat steps, so it packs small.
            halo: round(2 * glow * scale),
            blur: round(glow * scale),
            ax,
            ay,
            bx,
            by,
            accent,
            rim,
            tip,
        },
        width: Math.max(8, Math.round((frame[1] - frame[0]) * density[width - 1])),
        frame: down ? flipped(frame, bounds(arrowOutline(direction, width).points)[2] - y0) : frame,
    }
}
