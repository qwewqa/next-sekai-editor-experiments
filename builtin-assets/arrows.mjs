// Flick arrow art, drawn per direction and width in the engine's arrow square (side 1, y up from
// its bottom edge) so the shapes land undistorted: a filled, notched arrowhead with a broad light
// rim and a soft glow in the rim's colour. Sizes follow the base skin's arrows (Next SEKAI 01):
// where each lands and how much of it is inked, measured in the same square. A diagonal is the up
// arrow of its width turned to the base's tilt, so it points the way the engine moves it.

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
// The base's diagonal arrowheads by width (its motion trail left out): the x of the fill's
// centroid, and the lowest point of the up-left and of the down-left fill.
export const diagonalPlaces = [
    [0.41, 0.29, 0.18],
    [0.38, 0.21, 0.12],
    [0.36, 0.15, 0.08],
    [0.34, 0.11, 0.06],
    [0.345, 0.09, 0.05],
    [0.34, 0.08, 0.04],
]

// The arms' thickness as a share of the height: a notched "house" on narrow notes (the notch
// about 36% of the height), a chevron with arms at least 45% of it on wide ones. Area = W x S, the
// base's inked area.
const armShare = [0.64, 0.62, 0.58, 0.52, 0.48, 0.46]
// The base's diagonals point this far from straight up or down, at every width. The engine moves
// them 26.6 degrees off vertical.
export const tiltDegrees = 22
// Texture pixels per unit of the square. The engine's square is min(width / 2, 3) lanes, so every
// width from 2 gets 84 texels per lane on screen, and width 1 gets 120.
export const density = [60, 84, 126, 168, 210, 252]
// A multiplier on the glow's room, by width. Widths 1 and 2 get more, since their square is small on
// screen and the glow softens the arrow's silhouette.
const glowRoom = [2, 1.5, 1, 1, 1, 1]

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
const centroid = (points) => {
    const area = signedArea(points)
    const sum = points.reduce(
        ([sx, sy], [x, y], i) => {
            const [nx, ny] = points[(i + 1) % points.length]
            const cross = x * ny - nx * y
            return [sx + (x + nx) * cross, sy + (y + ny) * cross]
        },
        [0, 0],
    )
    return sum.map((value) => value / (6 * area))
}
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
    const down = direction === 'down' || direction === 'downLeft'
    const [u0, u1, v0, v1] = upBoxes[width - 1]
    const [w, h] = [u1 - u0, v1 - v0]
    const angle = diagonal ? (tiltDegrees * Math.PI) / 180 : 0
    // The outline, then the tip and the middle of the base, turned about the middle.
    let points = turnBy(
        [...upOutline(w, h, armShare[width - 1] * h), [0, h], [0, 0]].map(([x, y]) => [
            x,
            y - h / 2,
        ]),
        angle,
    )
    if (down) points = points.map(([x, y]) => [x, -y])
    const shape = points.slice(0, 6)
    const [x0, , y0] = bounds(shape)
    // Up and down arrows on the base's box, down arrows lower; diagonals on the base's arrowheads.
    let place
    if (diagonal) {
        const [x, upLow, downLow] = diagonalPlaces[width - 1]
        const [cx] = centroid(shape)
        place = ([px, py]) => [px - cx + x, py - y0 + (down ? downLow : upLow)]
    } else {
        const bottom = v0 - (down ? downDrop[width - 1] : 0)
        place = ([px, py]) => [px - x0 + u0, py - y0 + bottom]
    }
    const [tip, tail] = points.slice(6).map(place)
    return { points: shape.map(place), tip, tail }
}

// The frame moved up by shift and turned upside down.
const flipped = ([u0, u1, v0, v1], shift) => [u0, u1, v1 + shift, v0 + shift]

/**
 * The sprite of an arrow: template variables, the texture width and the frame [u0, u1, v0, v1] in
 * the arrow square that the texture covers. Down arrows are their up arrow's art, flipped by the
 * frame (v0 above v1), so the two share a texture.
 */
export function arrowSprite(direction, width, { accent, rim, tip }, pixels = density[width - 1]) {
    const down = direction === 'down' || direction === 'downLeft'
    const up = down ? (direction === 'down' ? 'up' : 'upLeft') : direction
    const { points, tip: tipAt, tail } = arrowOutline(up, width)
    const [x0, x1, y0, y1] = bounds(points)
    // Rim, corner rounding and the glow's room in square units. The rim is about 5 pixels at the
    // judge line.
    const rimWidth = 0.12 / Math.sqrt(width)
    const rounding = 0.03 / Math.sqrt(width)
    const margin = (0.025 + 0.003 * width + 0.01) * glowRoom[width - 1]
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
            // The glow, a near and a wide blur of the outline in the rim's colour, and the blur that
            // softens the rim's outer edge into it.
            near: round((margin / 4) * scale),
            wide: round((margin / 2.5) * scale),
            edge: round(0.12 * rimWidth * scale),
            ax,
            ay,
            bx,
            by,
            accent,
            rim,
            tip,
        },
        width: Math.max(8, Math.round((frame[1] - frame[0]) * pixels)),
        frame: down ? flipped(frame, bounds(arrowOutline(direction, width).points)[2] - y0) : frame,
    }
}
