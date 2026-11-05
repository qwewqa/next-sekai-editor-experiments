// Sprite names -> template and parameters, the particle table, the clip table and the item metadata.
import product from '../src/product.json' with { type: 'json' }
import { arrowSprite } from './arrows.mjs'
import {
    arrowColors,
    baseColors,
    bodyColors,
    colorNames,
    damage,
    diamondColors,
    guideColor,
    laneAlpha,
    laneColors,
    mix,
    stage,
    styleColors,
    traceColors,
} from './palette.mjs'

/** The shown product name, from the one constant in src/product.json. */
export const productName = product.name

/** Bumped when the set's art changes. */
export const setVersion = 1

/**
 * The original names (tests/fixtures/next-sekai-originals.json) the set leaves out: the stage that
 * bakes in its dividers, which would replace the drawn stage on every chart without stage changes.
 */
export const omittedOriginals = ['Sekai Stage']

/**
 * The engine names the set leaves out on purpose: those above and the colored judgment bands,
 * which the base set lacks too. The engine falls back to the uncolored one.
 */
export const omittedSprites = [
    ...omittedOriginals,
    ...colorNames.map((color) => `Sekai Judgment Background ${color}`),
]

// An image's options: stretch, width, transform, and glow, the one flat colour its soft glow or
// halo is drawn in, which the build stores exactly in the glow's pixels (build.mjs, snapGlow).
const image = (template, vars = {}, options = {}) => ({
    template,
    vars,
    stretch: false,
    ...options,
})
const solid = (color, alpha = 1, w = 4, h = 4) =>
    image('solid', { color, alpha, w, h }, { stretch: true })
// A strip along the whole stage, the far end at its top, rising from clear over the far 11.7 % as
// the base's do: the alpha at a quarter, half and three quarters of the rise, an ease-in.
const strip = (color, alpha) =>
    image(
        'strip',
        { color, alpha, qa: alpha / 16, ha: alpha / 4, ta: (alpha * 9) / 16 },
        { stretch: true },
    )
// A connector band: feathered sides, lighter towards them.
const band = (color, alpha = 0.8, light = mix(color, '#ffffff', 0.35)) =>
    image('band', { color, light, alpha }, { stretch: true })
// A connector at rest and held, in the base set's colours: [rest, held].
const bands = ([rest, held]) => [band(rest), band(held, 0.8, mix(held, '#ffffff', 0.3))]
// Slot glows in the base set's glow colours: [at the note, middle, top], up to a height of the cell.
const glow = ([light, color, top], height = 1) =>
    image(
        'slot-glow',
        { light, color, top, y: n(128 * (1 - height)), h: n(128 * height) },
        { stretch: true },
    )
// Slots fill their lane cell exactly with square corners, the rim on the cell's edge and a soft
// glow past it, the way the base's do (its 128 px square over the cell's -0.28 to 1.28).
const slot = (color) =>
    image('slot', { color }, { width: 192, transform: box(-0.28, 1.28, -0.28, 1.28), glow: color })
// Diamonds and ticks draw the art 1.4 times the engine's square about its middle, trace diamonds
// 1.28 times, at 144 and 108 texels per lane on screen: [texture width, half the art's side].
const kiteRoles = { slide: [128, 0.7], trace: [88, 0.64] }
const kiteImage = (template, vars, role, scale = 1) => {
    const [width, half] = kiteRoles[role]
    const side = half * scale
    return image(template, vars, {
        width: Math.round(width * scale),
        transform: box(0.5 - side, 0.5 + side, 0.5 - side, 0.5 + side),
        ...(vars.halo && { glow: vars.halo }),
    })
}
/**
 * The frame of a diamond against its kite's: room for a critical diamond's halo. Normal diamonds
 * share it, since the engine's perspective mapping places art alike only on the same quad.
 */
export const diamondFrameScale = 88 / 64
const diamondView = '-12 -12 88 88'
const kite = (color, role) =>
    kiteImage('kite', { color, view: diamondView }, role, diamondFrameScale)
// The standard ticks keep the kite's own frame.
const tick = (color) => kiteImage('kite', { color, view: '0 0 64 64' }, 'slide')
// Critical diamonds, as the base marks them: a soft halo round the kite in its deep colour, and
// the face a fifth of the way to it. The grey styles' halo is too dark to show on the stage, so
// their trace diamonds take a light one, and their faces keep their own lightness.
const criticalKite = (color, role, halo) =>
    kiteImage('kite-critical', { color: mix(color, halo, 0.2), halo }, role, diamondFrameScale)
const greyCriticalKite = (color, role, halo) =>
    kiteImage(
        'kite-critical',
        { color, halo: role === 'trace' ? mix(color, '#ffffff', 0.5) : halo },
        role,
        diamondFrameScale,
    )

/**
 * A sprite transform that draws the sprite's frame over the box [u0, u1] x [v0, v1] of the engine's
 * quad (0 to 1 from its bottom-left corner), so the art lands where the base skin's does on screen.
 * Each corner is a bilinear mix of the quad's four, so the box follows a perspective quad's slanted
 * edges and neighbouring slices still share their corners.
 */
export function box(u0, u1, v0, v1) {
    const corner = (u, v) => ({ 1: (1 - u) * (1 - v), 2: (1 - u) * v, 3: u * v, 4: u * (1 - v) })
    const corners = [corner(u0, v0), corner(u0, v1), corner(u1, v1), corner(u1, v0)]
    const out = {}
    for (const axis of ['x', 'y'])
        corners.forEach((weights, i) => {
            out[`${axis}${i + 1}`] = Object.fromEntries(
                Object.entries(weights)
                    .filter(([, weight]) => Math.abs(weight) > 1e-9)
                    .map(([k, weight]) => [`${axis}${k}`, Math.round(weight * 1e6) / 1e6]),
            )
        })
    return out
}

// Arrows: the base's pink (or gold) fill, lighter towards the tip, inside a broad light rim of the
// same hue, so they keep their colour at the engine's reduced alpha. A critical arrow's rim keeps
// more of its colour, so the two kinds stay apart.
const arrowTint = (accent, critical) => ({
    accent,
    tip: mix(accent, '#ffffff', 0.3),
    rim: mix(accent, '#ffffff', critical ? 0.45 : 0.7),
})
const arrow = (direction, accent, width, critical) => {
    const tint = arrowTint(accent, critical)
    const { vars, width: pixels, frame } = arrowSprite(direction, width, tint)
    return image('arrow', vars, { width: pixels, transform: box(...frame), glow: tint.rim })
}
// The marker draws in the flick judgment icons and stands in for missing arrows: the width 3 up
// arrow, placed as in its own square like the base's, at 2 x 104 texels per unit for the larger
// quad.
const marker = (accent, critical) => {
    const tint = arrowTint(accent, critical)
    const { vars, width, frame } = arrowSprite('up', 3, tint, 104)
    return image('arrow', vars, { width: 2 * width, transform: box(...frame), glow: tint.rim })
}

// Note bodies fill their slices' quads exactly, as the base's bodies do (its lower band included):
// a note one lane wide on the judge line then covers its lane's slot cell, which is the same quad
// (layout_slot_effect). At stage tilt 0 a note is one lane tall, its end slices 0.25 lane (slim
// 0.125) wide, so the art is drawn in units square on screen there (192 a lane), its borders even
// and its corners round; the texture squeezes the units (taller units at other tilts).
const NOTE_EDGE_W = 0.25
const NOTE_SLIM_EDGE_W = 0.125
/** The art's height in units for an end slice `pixels` wide over `edge` lanes. */
export const unitHeight = (pixels, edge) => pixels / edge
const bodyH = unitHeight(48, NOTE_EDGE_W)
const slimH = unitHeight(24, NOTE_SLIM_EDGE_W)
const damageH = unitHeight(48, NOTE_EDGE_W)
const n = (value) => Math.round(value * 1000) / 1000
// A shape from x to the slice's inner end and from top to bottom, its outer corners rounded.
const endShape = (x, top, bottom, radius, end = 48) =>
    `M${end} ${n(top)}H${n(x + radius)}A${radius} ${radius} 0 0 0 ${n(x)} ${n(top + radius)}` +
    `V${n(bottom - radius)}A${radius} ${radius} 0 0 0 ${n(x + radius)} ${n(bottom)}H${end}Z`
// The base's border is about 0.07 lane at tilt 0; its mark fills the face from the border's inner
// edge to 0.236 lane in from the note's edge, over the middle third of the face's height, its inner
// corners a little round.
const border = 14
const markEnd = 0.236 * bodyH
const markShape = (top, bottom, radius = 4) =>
    `M${border} ${n(top)}H${n(markEnd - radius)}A${radius} ${radius} 0 0 1 ${n(markEnd)} ` +
    `${n(top + radius)}V${n(bottom - radius)}A${radius} ${radius} 0 0 1 ${n(markEnd - radius)} ` +
    `${n(bottom)}H${border}Z`
const bodyVars = {
    h: n(bodyH),
    rim: endShape(0, 0, bodyH, border),
    face: endShape(border, border, bodyH - border, 8),
    mark: markShape(bodyH / 3, (2 * bodyH) / 3),
    border,
    span: n(bodyH - 2 * border),
}
// Slim traces: a bar half the note's height through its middle, as the base's.
const slimTop = slimH / 4
const slimVars = {
    h: n(slimH),
    face: endShape(0, slimTop, slimH - slimTop, 8, 24),
    top: n(slimTop),
    span: n(slimH - 2 * slimTop),
}
// A light lower edge an eighth of the bar's height, as the base's traces have.
const slimEdge = (light) =>
    light
        ? {
              light,
              ly: n(slimH - slimTop - (slimH - 2 * slimTop) / 8),
              lh: n((slimH - 2 * slimTop) / 8),
          }
        : { light: 'none', ly: 0, lh: 0 }
// Damage: half the height through its middle, as the base's bright bar (its dark rim left out),
// with a 4 unit rim.
const damageTop = damageH / 4
const damageVars = {
    h: n(damageH),
    rim: endShape(0, damageTop, damageH - damageTop, 22),
    face: endShape(4, damageTop + 4, damageH - damageTop - 4, 18),
    top: n(damageTop),
    span: n(damageH - 2 * damageTop),
    inset: n(damageTop + 4),
    inside: n(damageH - 2 * damageTop - 8),
}
// The damage art at the slim end width (24 units), for the base's purple trace, its damage note.
const damageSlimVars = {
    h: n(damageH),
    rim: endShape(0, damageTop, damageH - damageTop, 22, 24),
    face: endShape(4, damageTop + 4, damageH - damageTop - 4, 18, 24),
}
const basicBox = box(-0.02, 1.02, -0.06, 1.06)

const capital = (word) => word[0].toUpperCase() + word.slice(1).toLowerCase()
// Styled critical notes have their own colours, as the base's do.
const isCritical = (family) => family.startsWith('Critical')
// A style's normal trace bar and light edge: Black's from the base, the others the style's accent.
const traceOf = (color) =>
    color === 'Black'
        ? { bar: baseColors.blackTrace.bar, light: baseColors.blackTrace.edge }
        : { bar: styleColors(color)[2] }

// Critical notes in play carry a soft halo in the base's critical halo colour, under half alpha
// outside the art so the note keeps its cell: the critical diamonds' (above), and this glow round
// critical bodies and traces. Normal notes and the result-bucket Basics have none. The glow is a
// Gaussian blur of the art's box in the style's light critical glow colour, under the art: 0.4
// alpha at the art's edge, so the art's half-alpha edge stays put, fading out 3 sigma past it. It
// is drawn as the product of two gradients, across the note and along it, so the slices join where
// a blur filter, cut at each slice's edge, would leave seams. Every body and trace slice has the
// glow's frame, since the engine's perspective mapping places art alike only on the same quad.
const glowAcross = 32 // sigma across the note, in units: 0.106 lane at tilt 0
const glowAlong = 20 // and along it: 0.104 lane
const glowAtEdge = 0.4
// The standard normal distribution function, with erf by Abramowitz and Stegun 7.1.26.
const phi = (t) => {
    const x = Math.abs(t) / Math.SQRT2
    const k = 1 / (1 + 0.3275911 * x)
    const poly =
        ((((1.061405429 * k - 1.453152027) * k + 1.421413741) * k - 0.284496736) * k +
            0.254829592) *
        k
    const erf = 1 - poly * Math.exp(-x * x)
    return t >= 0 ? (1 + erf) / 2 : (1 - erf) / 2
}
const r4 = (value) => Math.round(value * 1e4) / 1e4
const smoothstep = (t) => t * t * (3 - 2 * t)
const gradientStops = (count, color, alpha) =>
    Array.from(
        { length: count + 1 },
        (_, i) =>
            `<stop offset="${r4(i / count)}" stop-color="${color}" stop-opacity="${r4(alpha(i / count))}"/>`,
    ).join('')
// The glow along a slice, at d units in from the art's outer end: the blur's edge outside, then
// eased to exactly 1, flat, at the slice's inner end, where the middle slice carries it on.
const alongEnd = (d, end) =>
    d <= 0 ? phi(d / glowAlong) : 1 - (1 - phi(d / glowAlong)) * (1 - smoothstep(d / end))

/** A body or trace slice's frame and glow: the vars and transform for its template. */
function noteSlice(kind, part, glow) {
    const [h, y0, end] = kind === 'body' ? [bodyH, 0, 48] : [slimH, slimTop, 24]
    const y1 = h - y0
    const width = part === 'Middle' ? 16 : end
    const pad = part === 'Middle' ? 0 : 3 * glowAlong
    const rise = 3 * glowAcross - y0
    const tall = h + 2 * rise
    const peak = glowAtEdge / (0.5 - phi((y0 - y1) / glowAcross))
    const across = (t) => {
        const y = -rise + t * tall
        return peak * (phi((y - y0) / glowAcross) - phi((y - y1) / glowAcross))
    }
    const vars = {
        view: `${part === 'Left' ? -pad : 0} ${n(-rise)} ${width + pad} ${n(tall)}`,
        pw: width + pad,
        ph: (96 * tall) / h,
        vya: n(-rise),
        vyb: n(h + rise),
        vyh: n(tall),
        halo: glow ? 'url(#v)' : 'none',
        vstops: glow ? gradientStops(48, glow, across) : '',
    }
    if (part !== 'Middle')
        Object.assign(vars, {
            hxa: part === 'Left' ? -pad : end + pad,
            hxb: part === 'Left' ? end : 0,
            hstops: glow
                ? gradientStops(32, '#fff', (t) => alongEnd(-pad + t * (pad + end), end))
                : '',
        })
    const [u0, u1] = [part === 'Left' ? -pad / end : 0, part === 'Right' ? 1 + pad / end : 1]
    return { vars, transform: box(u0, u1, -rise / h, 1 + rise / h) }
}

const parts = ['Left', 'Middle', 'Right']
const sliceImage = (kind, part, vars, glow) => {
    const slice = noteSlice(kind, part, glow)
    return image(
        `note-${kind === 'body' ? 'body' : 'slim'}-${part.toLowerCase()}`,
        { ...vars, ...slice.vars },
        { stretch: true, transform: slice.transform, ...(glow && { glow }) },
    )
}
/** A body slice in [outer, inner, accent], with a critical note's glow colour if given. */
const bodyImage = (part, [outer, inner, accent], glow) =>
    sliceImage('body', part, { ...bodyVars, outer, inner, accent }, glow)
/** A trace slice, its bar in accent, a light lower edge if given, and a critical note's glow. */
const slimImage = (part, accent, light, glow) =>
    sliceImage('slim', part, { ...slimVars, accent, ...slimEdge(light) }, glow)
// The whole-note trace and damage bars and their Basic {Color}: a bar on the base's ink box for its
// kind, a third of its height round at the corners. Damage keeps its rim.
const barBoxes = {
    trace: [0.15, 0.85, 0.37, 0.63],
    critical: [0.13, 0.87, 0.33, 0.67],
    damage: [0.12, 0.88, 0.31, 0.69],
}
const bar = (kind, color, { edge = 'none', light } = {}) => {
    const [u0, u1, v0, v1] = barBoxes[kind]
    // The Basic frame: u -0.02 to 1.02 over 144, v -0.06 to 1.06 over 96, v up.
    const x = ((u0 + 0.02) / 1.04) * 144
    const w = ((u1 + 0.02) / 1.04) * 144 - x
    const y = ((1.06 - v1) / 1.12) * 96
    const h = ((1.06 - v0) / 1.12) * 96 - y
    const rim = edge === 'none' ? 0 : 3
    return image(
        'note-bar-basic',
        {
            x: n(x),
            y: n(y),
            w: n(w),
            h: n(h),
            r: n(h / 3),
            ix: n(x + rim),
            iy: n(y + rim),
            iw: n(w - 2 * rim),
            ih: n(h - 2 * rim),
            ir: n(h / 3 - rim),
            color,
            edge,
            light: light ?? 'none',
            ly: n(y + (light ? (7 * h) / 8 : h)),
            lh: n(light ? h / 8 : 0),
        },
        { transform: basicBox },
    )
}
const damageImage = (part, color, edge) =>
    image(`note-damage-${part.toLowerCase()}`, { ...damageVars, color, edge }, { stretch: true })

const bodyFamilies = [
    ['Normal Note', 'tap'],
    ['Slide Note', 'slide'],
    ['Flick Note', 'flick'],
    ['Down Flick Note', 'flick'],
    ['Critical Note', 'critical'],
    ['Critical Slide Note', 'critical'],
    ['Critical Flick Note', 'critical'],
    ['Critical Down Flick Note', 'critical'],
]
const traceFamilies = [
    ['Normal Trace Note', 'green'],
    ['Trace Flick Note', 'red'],
    ['Trace Down Flick Note', 'red'],
    ['Critical Trace Note', 'yellow'],
    ['Critical Trace Flick Note', 'yellow'],
    ['Critical Trace Down Flick Note', 'yellow'],
]
const basicFamilies = [
    ['Normal', 'body', 'tap'],
    ['Slide', 'body', 'slide'],
    ['Flick', 'body', 'flick'],
    ['Critical', 'body', 'critical'],
    ['Critical Flick', 'body', 'critical'],
    ['Critical Slide', 'body', 'critical'],
    ['Damage', 'damage'],
    ['Normal Trace', 'slim', 'green'],
    ['Trace Flick', 'slim', 'red'],
    ['Critical Trace', 'slim', 'yellow'],
    ['Critical Trace Flick', 'slim', 'yellow'],
]
const diamondFamilies = [
    ['Normal Slide Diamond', 'green', 'slide'],
    ['Critical Slide Diamond', 'yellow', 'slide'],
    ['Normal Trace Diamond', 'green', 'trace'],
    ['Trace Flick Diamond', 'red', 'trace'],
    ['Trace Down Flick Diamond', 'red', 'trace'],
    ['Critical Trace Diamond', 'yellow', 'trace'],
    ['Critical Trace Flick Diamond', 'yellow', 'trace'],
    ['Critical Trace Down Flick Diamond', 'yellow', 'trace'],
]
const slotFamilies = [
    ['Normal', 'tap', 'Cyan'],
    ['Slide', 'slide', 'Green'],
    ['Flick', 'flick', 'Red'],
    ['Down Flick', 'flick', 'Red'],
    ['Critical', 'critical', 'Yellow'],
    ['Critical Slide', 'critical', 'Yellow Slider Tap'],
    ['Critical Flick', 'critical', 'Yellow Flick'],
    ['Critical Down Flick', 'critical', 'Yellow Flick'],
]
const directions = [
    ['Up', 'up'],
    ['Up Left', 'upLeft'],
    ['Down', 'down'],
    ['Down Left', 'downLeft'],
]

/** Every skin sprite name with its image: { template, vars, stretch, width? }, plus counts by group. */
export function skinSprites() {
    const sprites = new Map()
    const groups = new Map()
    let current = ''
    const group = (name, build) => {
        current = name
        build()
    }
    const add = (name, spec) => {
        if (sprites.has(name)) throw new Error(`Duplicate sprite name: ${name}`)
        sprites.set(name, spec)
        groups.set(current, (groups.get(current) ?? 0) + 1)
    }
    const alias = (name, target) => {
        const spec = sprites.get(target)
        if (!spec) throw new Error(`Unknown alias target: ${target}`)
        add(name, spec)
    }

    group('Stage, standard', () => {
        add('#STAGE_COVER', solid(stage.navy))
        // Two lanes, a divider line at each edge, as the base's.
        add(
            '#LANE',
            image(
                'lane',
                { color: stage.navy, alpha: 0.85, edge: stage.stroke, edgealpha: 0.3 },
                { stretch: true },
            ),
        )
        add('#STAGE_MIDDLE', solid(stage.navy, 0.5))
        add('#JUDGMENT_LINE', image('judgment-line', {}, { stretch: true }))
        // Half a lane outside the lanes, each drawn as it is: a line at the edge next to the lanes.
        add('#STAGE_LEFT_BORDER', { ...solid(stage.stroke, 0.7), transform: box(0.875, 1, 0, 1) })
        add('#STAGE_RIGHT_BORDER', { ...solid(stage.stroke, 0.7), transform: box(0, 0.125, 0, 1) })
        // Above and below the lanes the same line, and a dot where two lines meet.
        const edge = (u0, u1, v0, v1) => ({
            ...solid(stage.stroke, 0.7),
            transform: box(u0, u1, v0, v1),
        })
        add('#STAGE_TOP_BORDER', edge(0, 1, 0, 0.125))
        add('#STAGE_BOTTOM_BORDER', edge(0, 1, 0.875, 1))
        add('#STAGE_TOP_LEFT_CORNER', edge(0.875, 1, 0, 0.125))
        add('#STAGE_TOP_RIGHT_CORNER', edge(0, 0.125, 0, 0.125))
        add('#STAGE_BOTTOM_LEFT_CORNER', edge(0.875, 1, 0.875, 1))
        add('#STAGE_BOTTOM_RIGHT_CORNER', edge(0, 0.125, 0.875, 1))
        for (const name of ['LANE', 'STAGE_LEFT_BORDER', 'STAGE_RIGHT_BORDER'])
            alias(`#${name}_SEAMLESS`, `#${name}`)
        for (const name of ['STAGE_TOP_BORDER', 'STAGE_BOTTOM_BORDER'])
            alias(`#${name}_SEAMLESS`, `#${name}`)
        alias('#LANE_ALTERNATIVE', '#LANE')
        alias('#LANE_ALTERNATIVE_SEAMLESS', '#LANE')
    })

    group('Stage, Sekai', () => {
        // Lane effects draw under the lane, so it lets them through, like the base's.
        add('Sekai Lane Background', strip(stage.lane, laneAlpha))
        for (const [color, shade] of Object.entries(laneColors))
            add(`Sekai Lane Background ${color}`, strip(shade, laneAlpha))
        add('Sekai Lane Divider', strip(stage.stroke, 0.3))
        add('Sekai Stage Border', strip(stage.stroke, 0.7))
        // Preview mode draws its strips in pieces along the stage, so they stay even.
        add('Sekai Lane Background Preview', solid(stage.lane, laneAlpha, 4, 64))
        for (const [color, shade] of Object.entries(laneColors))
            add(`Sekai Lane Background Preview ${color}`, solid(shade, laneAlpha, 4, 64))
        add('Sekai Lane Divider Preview', solid(stage.stroke, 0.3, 4, 64))
        // Preview mode draws it on a strip 0.15 lane wide beside the stage: the line at its inner
        // third, next to the stage, as the base's ramp brightens towards it.
        add('Sekai Stage Border Preview', {
            ...solid(stage.stroke, 0.7),
            transform: box(2 / 3, 1, 0, 1),
        })
    })

    // Opaque strips and dividers in the base's colours: its edge colour at the stage edges and on
    // the dividers' ends, its centre colour at the centre, over a dark band. Where the base leaves
    // a sprite out (the coloured bands, the single line, the end caps), the engine's fallback's
    // colour.
    group('Judgment', () => {
        const [shade, alpha] = baseColors.judgmentBand
        add('Sekai Judgment Background', solid(shade, alpha))
        for (const color of colorNames) {
            const [edge, centre] = baseColors.judgmentLine[color]
            add(
                `Sekai Judgment Gradient ${color}`,
                image('judgment-gradient', { edge, centre }, { stretch: true }),
            )
            add(`Sekai Judgment Edge ${color}`, solid(edge))
            add(`Sekai Judgment Single Line ${color}`, solid(edge))
            add(`Sekai Judgment Edge Left ${color}`, solid(edge, 1, 8, 4))
            add(`Sekai Judgment Center ${color}`, solid(centre))
        }
    })

    group('Note bodies, default', () => {
        for (const [family, key] of bodyFamilies)
            for (const part of parts)
                add(
                    `Sekai ${family} ${part}`,
                    bodyImage(part, bodyColors[key], isCritical(family) && baseColors.criticalGlow),
                )
        for (const part of parts)
            add(`Sekai Damage Note ${part}`, damageImage(part, damage.color, damage.edge))
    })

    group('Trace bodies (slim)', () => {
        for (const [family, key] of traceFamilies)
            for (const part of parts)
                add(
                    `Sekai ${family} ${part}`,
                    slimImage(
                        part,
                        traceColors[key],
                        undefined,
                        isCritical(family) && baseColors.criticalGlow,
                    ),
                )
    })

    group('Legacy colour bodies', () => {
        for (const [color, family] of [
            ['Cyan', 'Normal Note'],
            ['Green', 'Slide Note'],
            ['Red', 'Flick Note'],
            ['Yellow', 'Critical Note'],
        ])
            for (const part of parts)
                alias(`Sekai Note ${color} ${part}`, `Sekai ${family} ${part}`)
        for (const [color, accent, bodyGlow] of [
            ['Green', traceColors.green],
            ['Red', traceColors.red],
            ['Yellow', traceColors.yellow, baseColors.criticalGlow],
        ])
            for (const part of parts)
                add(
                    `Sekai Trace Note ${color} ${part}`,
                    slimImage(part, accent, undefined, bodyGlow),
                )
        // The base's purple trace is its damage note, drawn at the slim end width.
        for (const part of ['Left', 'Right'])
            add(
                `Sekai Trace Note Purple ${part}`,
                image(
                    `note-damage-slim-${part.toLowerCase()}`,
                    { ...damageSlimVars, color: damage.color, edge: damage.edge },
                    { stretch: true },
                ),
            )
        alias('Sekai Trace Note Purple Middle', 'Sekai Damage Note Middle')
    })

    group('Basic (result buckets)', () => {
        for (const [family, kind, key] of basicFamilies) {
            const name = `Sekai ${family} Note Basic`
            if (kind === 'body') {
                const [outer, inner, accent] = bodyColors[key]
                add(
                    name,
                    image('note-body-basic', { outer, inner, accent }, { transform: basicBox }),
                )
            } else if (kind === 'damage')
                add(
                    name,
                    image(
                        'note-damage-basic',
                        { color: damage.color, edge: damage.edge },
                        { transform: basicBox },
                    ),
                )
            else
                add(
                    name,
                    image('note-slim-basic', { accent: traceColors[key] }, { transform: basicBox }),
                )
        }
    })

    group('Diamonds', () => {
        // Yellow is the critical colour of the default diamonds.
        const defaultKite = (key, role) =>
            key === 'yellow'
                ? criticalKite(diamondColors[key], role, baseColors.diamondHalo)
                : kite(diamondColors[key], role)
        for (const [family, key, role] of diamondFamilies)
            add(`Sekai ${family}`, defaultKite(key, role))
        for (const key of ['green', 'yellow'])
            add(`Sekai Diamond ${capital(key)}`, defaultKite(key, 'slide'))
        for (const key of ['green', 'red', 'yellow'])
            add(`Sekai Trace Diamond ${capital(key)}`, defaultKite(key, 'trace'))
    })

    group('Flick arrows', () => {
        for (const [family, color] of [
            ['Flick', arrowColors.normal],
            ['Critical Flick', arrowColors.critical],
        ])
            for (const [direction, key] of directions)
                for (let width = 1; width <= 6; width++)
                    add(
                        `Sekai ${family} Arrow ${direction} ${width}`,
                        arrow(key, color, width, family === 'Critical Flick'),
                    )
        for (const [color, family] of [
            ['Red', 'Flick'],
            ['Yellow', 'Critical Flick'],
        ])
            for (const [direction] of directions)
                for (let width = 1; width <= 6; width++)
                    alias(
                        `Sekai Flick Arrow ${color} ${direction} ${width}`,
                        `Sekai ${family} Arrow ${direction} ${width}`,
                    )
    })

    group('Slots and slot glows', () => {
        for (const [family, key, base] of slotFamilies) {
            add(`Sekai Slot ${family}`, slot(bodyColors[key][2]))
            add(`Sekai Slot Glow ${family}`, glow(baseColors.slotGlow[base]))
        }
        for (const [color, key] of [
            ['Cyan', 'tap'],
            ['Green', 'slide'],
            ['Red', 'flick'],
            ['Yellow', 'critical'],
            ['Yellow Flick', 'critical'],
            ['Yellow Slider', 'critical'],
        ])
            add(`Sekai Slot ${color}`, slot(bodyColors[key][2]))
        // The base's Slider Hold glows are shorter than the others, their tops at 0.54 and 0.39
        // of the cell; drawn in the same frame, clear above.
        const height = { 'Green Slider Hold': 0.83, 'Yellow Slider Hold': 0.6 }
        for (const [color, value] of Object.entries(baseColors.slotGlow))
            add(`Sekai Slot Glow ${color}`, glow(value, height[color]))
        add('Sekai Normal Slide Slot Glow', glow(baseColors.slotGlow['Green Slider Hold']))
        add('Sekai Critical Slide Slot Glow', glow(baseColors.slotGlow['Yellow Slider Hold']))
    })

    group('Connectors', () => {
        for (const [family, colors] of [
            ['Normal', baseColors.connector.normal],
            ['Critical', baseColors.connector.critical],
        ]) {
            const [rest, held] = bands(colors)
            add(`Sekai ${family} Active Slide Connection Normal`, rest)
            add(`Sekai ${family} Active Slide Connection Active`, held)
        }
        for (const [color, family] of [
            ['Green', 'Normal'],
            ['Yellow', 'Critical'],
        ]) {
            alias(
                `Sekai Active Slide Connection ${color}`,
                `Sekai ${family} Active Slide Connection Normal`,
            )
            alias(
                `Sekai Active Slide Connection ${color} Active`,
                `Sekai ${family} Active Slide Connection Active`,
            )
        }
        const [rest, held] = bands(baseColors.connector.damage)
        add('Sekai Damage Slide Connection', rest)
        add('Sekai Damage Slide Connection Active', held)
    })

    group('Guides', () => {
        for (const color of colorNames) add(`Sekai Guide ${color}`, solid(guideColor(color)))
    })

    group('Sim line', () => {
        // A thin line across the middle of the note height, as the engine stretches it between notes.
        add('#SIMULTANEOUS_CONNECTION_NEUTRAL', image('sim-line', {}, { stretch: true }))
    })

    group('Standard fallbacks', () => {
        for (const [color, key] of [
            ['CYAN', 'tap'],
            ['GREEN', 'slide'],
            ['RED', 'flick'],
            ['YELLOW', 'critical'],
        ]) {
            const [outer, inner, accent] = bodyColors[key]
            add(
                `#NOTE_HEAD_${color}`,
                image('note-body-basic', { outer, inner, accent }, { transform: basicBox }),
            )
        }
        {
            const [outer, inner, accent] = styleColors('Purple')
            add(
                '#NOTE_HEAD_PURPLE',
                image('note-body-basic', { outer, inner, accent }, { transform: basicBox }),
            )
        }
        for (const key of ['green', 'red', 'yellow'])
            add(`#NOTE_TICK_${key.toUpperCase()}`, tick(diamondColors[key]))
        for (const [color, accent] of [
            ['RED', arrowColors.normal],
            ['YELLOW', arrowColors.critical],
        ])
            add(`#DIRECTIONAL_MARKER_${color}`, marker(accent, color === 'YELLOW'))
        for (const color of ['NEUTRAL', 'RED', 'GREEN', 'BLUE', 'YELLOW', 'PURPLE', 'CYAN'])
            add(`#NOTE_CONNECTION_${color}_SEAMLESS`, band(guideColor(capital(color))))
        for (const color of ['NEUTRAL', 'RED', 'YELLOW', 'PURPLE', 'CYAN'])
            add(`#GRID_${color}`, solid(baseColors.grid[color]))
    })

    // Names only the base set carries: the standard colours the engine does not draw, the names
    // its sprites share, and the Basic bodies its build makes per style colour.
    group('Originals only', () => {
        const basic = ([outer, inner, accent]) =>
            image('note-body-basic', { outer, inner, accent }, { transform: basicBox })
        add('#NOTE_HEAD_NEUTRAL', basic(styleColors('Neutral')))
        add('#NOTE_HEAD_BLUE', basic(styleColors('Blue')))
        for (const color of ['NEUTRAL', 'RED', 'GREEN', 'BLUE', 'YELLOW', 'PURPLE', 'CYAN']) {
            alias(`#NOTE_TAIL_${color}`, `#NOTE_HEAD_${color}`)
            alias(`#NOTE_CONNECTION_${color}`, `#NOTE_CONNECTION_${color}_SEAMLESS`)
            if (color !== 'NEUTRAL')
                alias(`#SIMULTANEOUS_CONNECTION_${color}`, '#SIMULTANEOUS_CONNECTION_NEUTRAL')
            alias(`#SIMULTANEOUS_CONNECTION_${color}_SEAMLESS`, '#SIMULTANEOUS_CONNECTION_NEUTRAL')
        }
        for (const [color, face] of Object.entries(baseColors.tick))
            add(`#NOTE_TICK_${color.toUpperCase()}`, tick(face))
        for (const [color, face] of Object.entries(baseColors.marker))
            add(`#DIRECTIONAL_MARKER_${color.toUpperCase()}`, marker(face))
        for (const color of ['BLUE', 'GREEN']) add(`#GRID_${color}`, solid(baseColors.grid[color]))
        for (const color of ['Green', 'Yellow']) {
            alias(`Sekai Slide Connection ${color}`, `Sekai Active Slide Connection ${color}`)
            alias(
                `Sekai Slide Connection ${color} Active`,
                `Sekai Active Slide Connection ${color} Active`,
            )
        }
        add('Sekai Trace Note Green', bar('trace', traceColors.green))
        add('Sekai Trace Note Red', bar('trace', traceColors.red))
        add('Sekai Trace Note Yellow', bar('critical', traceColors.yellow))
        add('Sekai Trace Note Purple', bar('damage', damage.color, { edge: damage.edge }))
        for (const color of colorNames) {
            const [outer, inner, accent] = styleColors(color)
            const critical = baseColors.styleCritical[color]
            for (const [family] of bodyFamilies)
                add(
                    `Sekai ${family} Basic ${color}`,
                    basic(isCritical(family) ? critical.body : [outer, inner, accent]),
                )
            const trace = traceOf(color)
            for (const [family] of traceFamilies)
                add(
                    `Sekai ${family} Basic ${color}`,
                    isCritical(family)
                        ? bar('critical', critical.trace, { light: trace.light })
                        : bar('trace', trace.bar, { light: trace.light }),
                )
            add(`Sekai Damage Note Basic ${color}`, bar('damage', accent, { edge: inner }))
        }
    })

    group('Style colours', () => {
        for (const color of colorNames) {
            const [outer, inner, accent] = styleColors(color)
            const critical = baseColors.styleCritical[color]
            const bodyGlow = baseColors.styleCriticalGlow[color]
            for (const [family] of bodyFamilies)
                for (const part of parts)
                    add(
                        `Sekai ${family} ${part} ${color}`,
                        isCritical(family)
                            ? bodyImage(part, critical.body, bodyGlow)
                            : bodyImage(part, [outer, inner, accent]),
                    )
            const trace = traceOf(color)
            for (const [family] of traceFamilies)
                for (const part of parts)
                    add(
                        `Sekai ${family} ${part} ${color}`,
                        isCritical(family)
                            ? slimImage(part, critical.trace, trace.light, bodyGlow)
                            : slimImage(part, trace.bar, trace.light),
                    )
            for (const part of parts)
                add(`Sekai Damage Note ${part} ${color}`, damageImage(part, accent, inner))
            const [face, criticalFace] = baseColors.styleDiamond[color]
            const halo = baseColors.styleDiamondHalo[color]
            const haloed =
                color === 'Neutral' || color === 'Black' ? greyCriticalKite : criticalKite
            for (const [family, , role] of diamondFamilies)
                add(
                    `Sekai ${family} ${color}`,
                    isCritical(family) ? haloed(criticalFace, role, halo) : kite(face, role),
                )
            const [rest, held, criticalRest, criticalHeld, damaged, , , tint] =
                baseColors.style[color]
            const [slotGlow, criticalGlow] = baseColors.styleGlow[color]
            for (const [family] of slotFamilies) {
                add(
                    `Sekai Slot ${family} ${color}`,
                    slot(isCritical(family) ? critical.slot : accent),
                )
                add(
                    `Sekai Slot Glow ${family} ${color}`,
                    glow(isCritical(family) ? criticalGlow : slotGlow),
                )
            }
            for (const family of ['Normal', 'Critical'])
                add(
                    `Sekai ${family} Slide Slot Glow ${color}`,
                    glow(family === 'Critical' ? criticalGlow : slotGlow),
                )
            for (const family of ['Flick', 'Critical Flick'])
                for (const [direction, key] of directions)
                    for (let width = 1; width <= 6; width++)
                        add(
                            `Sekai ${family} Arrow ${direction} ${width} ${color}`,
                            family === 'Flick'
                                ? arrow(key, tint, width, false)
                                : arrow(key, critical.arrow, width, true),
                        )
            for (const [family, colors] of [
                ['Normal', [rest, held]],
                ['Critical', [criticalRest, criticalHeld]],
            ]) {
                const [bandRest, bandHeld] = bands(colors)
                add(`Sekai ${family} Active Slide Connection Normal ${color}`, bandRest)
                add(`Sekai ${family} Active Slide Connection Active ${color}`, bandHeld)
            }
            const [damageRest, damageHeld] = bands([damaged, damaged])
            add(`Sekai Damage Slide Connection ${color}`, damageRest)
            add(`Sekai Damage Slide Connection Active ${color}`, damageHeld)
        }
    })

    return { sprites, groups }
}

/** The particle sprites, in the order the effects index them (sprite in particles.mjs), and a
 * texture width where it differs from the template's: smaller for soft sprites, larger for the
 * sharp ones that draw large. */
export const particleSprites = [
    ['glow', 'particle-glow', 96],
    ['halo', 'particle-halo', 96],
    ['frame', 'particle-frame-thin', 256],
    ['line', 'particle-frame-line', 256],
    ['plate', 'particle-plate', 256],
    ['flare', 'particle-flare', 128],
    ['sparkle', 'particle-sparkle', 128],
    ['mote', 'particle-circle'],
    ['shard', 'particle-diamond'],
    ['arc', 'particle-arc', 256],
    ['flame', 'particle-flame'],
    ['needle', 'particle-needle', 64],
    ['ring', 'particle-ring', 256],
    ['wisp', 'particle-wisp'],
    ['fan', 'particle-fan'],
    ['flash', 'particle-flash'],
    ['streak', 'particle-streak'],
].map(([name, template, width]) => ({ name, spec: image(template, {}, width ? { width } : {}) }))

/** The 15 clips of the engine: the name in the data, the file in the audio zip. */
export const clipFiles = {
    '#PERFECT': 'perfect.wav',
    '#GREAT': 'great.wav',
    '#GOOD': 'good.wav',
    '#PERFECT_ALTERNATIVE': 'perfect-alternative.wav',
    '#GREAT_ALTERNATIVE': 'great-alternative.wav',
    '#GOOD_ALTERNATIVE': 'good-alternative.wav',
    '#HOLD': 'hold.wav',
    '#STAGE': 'stage.wav',
    'Sekai Tick': 'tick.wav',
    'Sekai Critical Tap': 'critical-tap.wav',
    'Sekai Critical Flick': 'critical-flick.wav',
    'Sekai Critical Hold': 'critical-hold.wav',
    'Sekai Critical Tick': 'critical-tick.wav',
    'Sekai Trace': 'trace.wav',
    'Sekai Critical Trace': 'critical-trace.wav',
}

/** Clips the base set plays from another clip's file: the name, and the clip whose file it plays. */
export const clipAliases = { '#HOLD_ALTERNATIVE': '#HOLD' }

/** The metadata shared by the four items. */
export const itemMeta = {
    name: 'nse-builtin',
    title: 'Editor',
    subtitle: productName,
    author: `${productName} contributors`,
    description: `CC0 1.0. Version ${setVersion}.`,
}
