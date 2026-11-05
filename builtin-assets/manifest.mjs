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

const image = (template, vars = {}, options = {}) => ({
    template,
    vars,
    stretch: false,
    ...options,
})
const solid = (color, alpha = 1, w = 4, h = 4) =>
    image('solid', { color, alpha, w, h }, { stretch: true })
// A connector band: feathered sides, lighter towards them.
const band = (color, alpha = 0.8, light = mix(color, '#ffffff', 0.35)) =>
    image('band', { color, light, alpha }, { stretch: true })
// A connector at rest and held, in the base set's colours: [rest, held].
const bands = ([rest, held]) => [band(rest), band(held, 0.8, mix(held, '#ffffff', 0.3))]
// Slot glows in the base set's glow colours: [at the note, middle, top].
const glow = ([light, color, top]) => image('slot-glow', { light, color, top }, { stretch: true })
// Slots fill their lane cell exactly with square corners, the rim on the cell's edge and a soft
// glow past it, the way the base's do (its 128 px square over the cell's -0.28 to 1.28).
const slot = (color) => image('slot', { color }, { transform: box(-0.28, 1.28, -0.28, 1.28) })
const kite = (color, width) => image('kite', { color }, { width, transform: kiteBox(width) })

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

// Arrows: the base's pink (or gold) fill, lighter towards the tip, inside a light rim of the same
// hue, so they keep their colour at the engine's reduced alpha.
const arrowTint = (accent) => ({
    accent,
    tip: mix(accent, '#ffffff', 0.3),
    rim: mix(accent, '#ffffff', 0.7),
})
const arrow = (direction, accent, width) => {
    const { vars, width: pixels, frame } = arrowSprite(direction, width, arrowTint(accent))
    return image('arrow', vars, { width: pixels, transform: box(...frame) })
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
// Diamonds are drawn 1.4 times their square about its middle, trace diamonds 1.28 times.
const kiteBox = (width) => (width < 64 ? box(-0.14, 1.14, -0.14, 1.14) : box(-0.2, 1.2, -0.2, 1.2))

const capital = (word) => word[0].toUpperCase() + word.slice(1).toLowerCase()

const parts = ['Left', 'Middle', 'Right']
const bodyImage = (part, [outer, inner, accent]) =>
    image(
        `note-body-${part.toLowerCase()}`,
        { ...bodyVars, outer, inner, accent },
        { stretch: true },
    )
const slimImage = (part, accent) =>
    image(`note-slim-${part.toLowerCase()}`, { ...slimVars, accent }, { stretch: true })
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
    ['Normal Slide Diamond', 'green', 64],
    ['Critical Slide Diamond', 'yellow', 64],
    ['Normal Trace Diamond', 'green', 44],
    ['Trace Flick Diamond', 'red', 44],
    ['Trace Down Flick Diamond', 'red', 44],
    ['Critical Trace Diamond', 'yellow', 44],
    ['Critical Trace Flick Diamond', 'yellow', 44],
    ['Critical Trace Down Flick Diamond', 'yellow', 44],
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
        add('Sekai Lane Background', solid(stage.lane, laneAlpha, 4, 64))
        for (const [color, shade] of Object.entries(laneColors))
            add(`Sekai Lane Background ${color}`, solid(shade, laneAlpha, 4, 64))
        add('Sekai Lane Divider', solid(stage.stroke, 0.3, 4, 64))
        add('Sekai Stage Border', solid(stage.stroke, 0.7, 4, 64))
        for (const name of ['Lane Background', 'Lane Divider', 'Stage Border'])
            alias(`Sekai ${name} Preview`, `Sekai ${name}`)
        for (const color of Object.keys(laneColors))
            alias(`Sekai Lane Background Preview ${color}`, `Sekai Lane Background ${color}`)
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
                add(`Sekai ${family} ${part}`, bodyImage(part, bodyColors[key]))
        for (const part of parts)
            add(`Sekai Damage Note ${part}`, damageImage(part, damage.color, damage.edge))
    })

    group('Trace bodies (slim)', () => {
        for (const [family, key] of traceFamilies)
            for (const part of parts)
                add(`Sekai ${family} ${part}`, slimImage(part, traceColors[key]))
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
        for (const [color, accent] of [
            ['Green', traceColors.green],
            ['Red', traceColors.red],
            ['Yellow', traceColors.yellow],
        ])
            for (const part of parts)
                add(`Sekai Trace Note ${color} ${part}`, slimImage(part, accent))
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
        for (const [family, key, width] of diamondFamilies)
            add(`Sekai ${family}`, kite(diamondColors[key], width))
        for (const key of ['green', 'yellow'])
            add(`Sekai Diamond ${capital(key)}`, kite(diamondColors[key], 64))
        for (const key of ['green', 'red', 'yellow'])
            add(`Sekai Trace Diamond ${capital(key)}`, kite(diamondColors[key], 44))
    })

    group('Flick arrows', () => {
        for (const [family, color] of [
            ['Flick', arrowColors.normal],
            ['Critical Flick', arrowColors.critical],
        ])
            for (const [direction, key] of directions)
                for (let width = 1; width <= 6; width++)
                    add(`Sekai ${family} Arrow ${direction} ${width}`, arrow(key, color, width))
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
        for (const [color, value] of Object.entries(baseColors.slotGlow))
            add(`Sekai Slot Glow ${color}`, glow(value))
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
            add(`#NOTE_TICK_${key.toUpperCase()}`, kite(diamondColors[key], 64))
        // The marker draws in the flick judgment icons and stands in for missing arrows: the width 3
        // up arrow, placed as in its own square like the base's, at twice the density for the
        // larger quad.
        for (const [color, accent] of [
            ['RED', arrowColors.normal],
            ['YELLOW', arrowColors.critical],
        ]) {
            const { vars, width, frame } = arrowSprite('up', 3, arrowTint(accent))
            add(
                `#DIRECTIONAL_MARKER_${color}`,
                image('arrow', vars, { width: 2 * width, transform: box(...frame) }),
            )
        }
        for (const color of ['NEUTRAL', 'RED', 'GREEN', 'BLUE', 'YELLOW', 'PURPLE', 'CYAN'])
            add(`#NOTE_CONNECTION_${color}_SEAMLESS`, band(guideColor(capital(color))))
        for (const color of ['NEUTRAL', 'RED', 'YELLOW', 'PURPLE', 'CYAN'])
            add(`#GRID_${color}`, solid(guideColor(capital(color))))
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
            add(`#NOTE_TICK_${color.toUpperCase()}`, kite(face, 64))
        for (const [color, face] of Object.entries(baseColors.marker)) {
            const { vars, width, frame } = arrowSprite('up', 3, arrowTint(face))
            add(
                `#DIRECTIONAL_MARKER_${color.toUpperCase()}`,
                image('arrow', vars, { width: 2 * width, transform: box(...frame) }),
            )
        }
        for (const color of ['Blue', 'Green'])
            add(`#GRID_${color.toUpperCase()}`, solid(guideColor(color)))
        for (const color of ['Green', 'Yellow']) {
            alias(`Sekai Slide Connection ${color}`, `Sekai Active Slide Connection ${color}`)
            alias(
                `Sekai Slide Connection ${color} Active`,
                `Sekai Active Slide Connection ${color} Active`,
            )
        }
        alias('Sekai Trace Note Green', 'Sekai Normal Trace Note Basic')
        alias('Sekai Trace Note Red', 'Sekai Trace Flick Note Basic')
        alias('Sekai Trace Note Yellow', 'Sekai Critical Trace Note Basic')
        alias('Sekai Trace Note Purple', 'Sekai Damage Note Basic')
        for (const color of colorNames) {
            const [outer, inner, accent] = styleColors(color)
            for (const [family] of bodyFamilies)
                add(`Sekai ${family} Basic ${color}`, basic([outer, inner, accent]))
            for (const [family] of traceFamilies)
                add(
                    `Sekai ${family} Basic ${color}`,
                    image('note-slim-basic', { accent }, { transform: basicBox }),
                )
            add(
                `Sekai Damage Note Basic ${color}`,
                image('note-damage-basic', { color: accent, edge: inner }, { transform: basicBox }),
            )
        }
    })

    group('Style colours', () => {
        for (const color of colorNames) {
            const [outer, inner, accent] = styleColors(color)
            for (const [family] of bodyFamilies)
                for (const part of parts)
                    add(`Sekai ${family} ${part} ${color}`, bodyImage(part, [outer, inner, accent]))
            for (const [family] of traceFamilies)
                for (const part of parts)
                    add(`Sekai ${family} ${part} ${color}`, slimImage(part, accent))
            for (const part of parts)
                add(`Sekai Damage Note ${part} ${color}`, damageImage(part, accent, inner))
            for (const [family, , width] of diamondFamilies)
                add(`Sekai ${family} ${color}`, kite(inner, width))
            const [rest, held, criticalRest, criticalHeld, damaged, , , tint] =
                baseColors.style[color]
            const [slotGlow, criticalGlow] = baseColors.styleGlow[color]
            for (const [family] of slotFamilies) {
                add(`Sekai Slot ${family} ${color}`, slot(accent))
                add(
                    `Sekai Slot Glow ${family} ${color}`,
                    glow(family.startsWith('Critical') ? criticalGlow : slotGlow),
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
                            arrow(key, tint, width),
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
 * width for the soft ones drawn smaller. */
export const particleSprites = [
    ['glow', 'particle-glow', 96],
    ['halo', 'particle-halo', 96],
    ['frame', 'particle-frame-thin'],
    ['line', 'particle-frame-line'],
    ['plate', 'particle-plate'],
    ['flare', 'particle-flare'],
    ['sparkle', 'particle-sparkle'],
    ['mote', 'particle-circle'],
    ['shard', 'particle-diamond'],
    ['arc', 'particle-arc'],
    ['flame', 'particle-flame'],
    ['needle', 'particle-needle'],
    ['ring', 'particle-ring'],
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
