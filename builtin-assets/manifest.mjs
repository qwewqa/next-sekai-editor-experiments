// Sprite names -> template and parameters, the particle table, the clip table and the item metadata.
import product from '../src/product.json' with { type: 'json' }
import { arrowSprite } from './arrows.mjs'
import {
    activeColors,
    arrowColors,
    bodyColors,
    colorNames,
    connectorColor,
    damage,
    damageColor,
    diamondColors,
    guideColor,
    mix,
    stage,
    styleColors,
    traceColors,
    vivid,
} from './palette.mjs'

/** The shown product name (Part 4, 4.1), from the one constant in src/product.json. */
export const productName = product.name

/** Bumped when the set's art changes. */
export const setVersion = 1

/** The one sprite the set leaves out on purpose (Part 2, 2.3.1). */
export const omittedSprites = ['Sekai Stage']

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
const activeBand = (color) => band(mix(color, '#ffffff', 0.2), 0.8, mix(color, '#ffffff', 0.6))
// Slot glows in the vivid effect colour, as the particles use.
const glow = (color) =>
    image(
        'slot-glow',
        { color: vivid(color), light: mix(vivid(color), '#ffffff', 0.5) },
        { stretch: true },
    )
const kite = (color, width) => image('kite', { color }, { width, transform: kiteBox(width) })

// The dark base of the judgment band.
const judgmentShade = '#0b0c16'

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

// Arrows: a saturated fill, lighter towards the tip, inside a light rim of the same hue, so they
// keep their colour at the engine's reduced alpha.
const arrowTint = (accent) => {
    const fill = mix(accent, vivid(accent), 0.5)
    return { accent: fill, tip: mix(fill, '#ffffff', 0.3), rim: mix(accent, '#ffffff', 0.7) }
}
const arrow = (direction, accent, width) => {
    const { vars, width: pixels, frame } = arrowSprite(direction, width, arrowTint(accent))
    return image('arrow', vars, { width: pixels, transform: box(...frame) })
}

// Note bodies sit 6% over and under their quad, as the base skin's do; their ends stop 0.02 of a
// lane inside the note, so notes side by side keep a gap. Slim traces keep their height in the art.
const bodyBox = {
    Left: box(0.08, 1, -0.06, 1.06),
    Middle: box(0, 1, -0.06, 1.06),
    Right: box(0, 0.92, -0.06, 1.06),
}
const slimBox = { Left: box(0.16, 1, 0, 1), Middle: undefined, Right: box(0, 0.84, 0, 1) }
const basicBox = box(-0.02, 1.02, -0.06, 1.06)
// Diamonds are drawn 1.4 times their square about its middle, trace diamonds 1.28 times.
const kiteBox = (width) => (width < 64 ? box(-0.14, 1.14, -0.14, 1.14) : box(-0.2, 1.2, -0.2, 1.2))

const capital = (word) => word[0].toUpperCase() + word.slice(1).toLowerCase()

const parts = ['Left', 'Middle', 'Right']
const bodyImage = (part, [outer, inner, accent]) =>
    image(
        `note-body-${part.toLowerCase()}`,
        { outer, inner, accent },
        { stretch: true, transform: bodyBox[part] },
    )
const slimImage = (part, accent) =>
    image(
        `note-slim-${part.toLowerCase()}`,
        { accent },
        { stretch: true, transform: slimBox[part] },
    )
const damageImage = (part, color, edge) =>
    image(
        `note-damage-${part.toLowerCase()}`,
        { color, edge },
        { stretch: true, transform: slimBox[part] },
    )

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
    ['Normal', 'tap'],
    ['Slide', 'slide'],
    ['Flick', 'flick'],
    ['Down Flick', 'flick'],
    ['Critical', 'critical'],
    ['Critical Slide', 'critical'],
    ['Critical Flick', 'critical'],
    ['Critical Down Flick', 'critical'],
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
        add('#LANE', solid(stage.navy, 0.85))
        add('#STAGE_MIDDLE', solid(stage.navy, 0.5))
        add('#JUDGMENT_LINE', image('judgment-line', {}, { stretch: true }))
        add('#STAGE_LEFT_BORDER', solid(stage.stroke, 1, 8, 4))
        add('#STAGE_RIGHT_BORDER', solid(stage.stroke, 1, 8, 4))
    })

    group('Stage, Sekai', () => {
        // Lane effects draw under the lane, so it lets them through, like the base's (0.40).
        add('Sekai Lane Background', solid(stage.lane, 0.55, 4, 64))
        add('Sekai Lane Divider', solid(stage.stroke, 0.3, 4, 64))
        add('Sekai Stage Border', solid(stage.stroke, 0.7, 4, 64))
        for (const name of ['Lane Background', 'Lane Divider', 'Stage Border'])
            alias(`Sekai ${name} Preview`, `Sekai ${name}`)
    })

    // Opaque strips and dividers: darker at the stage edges, lighter at the centre, over a dark band.
    group('Judgment', () => {
        add('Sekai Judgment Background', solid(judgmentShade, 0.55))
        for (const color of colorNames) {
            const hue = guideColor(color)
            const edge = mix(hue, '#000000', 0.2)
            const centre = mix(hue, '#ffffff', 0.3)
            add(`Sekai Judgment Background ${color}`, solid(mix(hue, judgmentShade, 0.85), 0.55))
            add(
                `Sekai Judgment Gradient ${color}`,
                image('judgment-gradient', { edge, centre }, { stretch: true }),
            )
            add(`Sekai Judgment Edge ${color}`, solid(edge))
            add(`Sekai Judgment Single Line ${color}`, solid(mix(hue, '#ffffff', 0.15)))
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
            ['Purple', styleColors('Purple')[2]],
        ])
            for (const part of parts)
                add(`Sekai Trace Note ${color} ${part}`, slimImage(part, accent))
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
        for (const [family, key] of slotFamilies) {
            add(`Sekai Slot ${family}`, image('slot', { color: bodyColors[key][2] }))
            add(`Sekai Slot Glow ${family}`, glow(bodyColors[key][2]))
        }
        for (const [color, key] of [
            ['Cyan', 'tap'],
            ['Green', 'slide'],
            ['Red', 'flick'],
            ['Yellow', 'critical'],
            ['Yellow Flick', 'critical'],
            ['Yellow Slider', 'critical'],
        ])
            add(`Sekai Slot ${color}`, image('slot', { color: bodyColors[key][2] }))
        for (const [color, key] of [
            ['Cyan', 'tap'],
            ['Green', 'slide'],
            ['Red', 'flick'],
            ['Yellow', 'critical'],
            ['Yellow Flick', 'critical'],
            ['Green Slider Hold', 'slide'],
            ['Yellow Slider Hold', 'critical'],
            ['Yellow Slider Tap', 'critical'],
        ])
            add(`Sekai Slot Glow ${color}`, glow(bodyColors[key][2]))
        add('Sekai Normal Slide Slot Glow', glow(bodyColors.slide[2]))
        add('Sekai Critical Slide Slot Glow', glow(bodyColors.critical[2]))
    })

    group('Connectors', () => {
        // The critical band in the gold of critical notes, a clear yellow like the base's.
        for (const [family, color] of [
            ['Normal', activeColors.normal],
            ['Critical', bodyColors.critical[2]],
        ]) {
            add(`Sekai ${family} Active Slide Connection Normal`, band(color))
            add(`Sekai ${family} Active Slide Connection Active`, activeBand(color))
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
        add('Sekai Damage Slide Connection', band(damageColor))
        add('Sekai Damage Slide Connection Active', activeBand(damageColor))
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
        // The fallback marker fills its quad.
        for (const [color, accent] of [
            ['RED', arrowColors.normal],
            ['YELLOW', arrowColors.critical],
        ]) {
            const { vars, width } = arrowSprite('up', 1, arrowTint(accent))
            add(`#DIRECTIONAL_MARKER_${color}`, image('arrow', vars, { width }))
        }
        for (const color of ['NEUTRAL', 'RED', 'GREEN', 'BLUE', 'YELLOW', 'PURPLE', 'CYAN'])
            add(`#NOTE_CONNECTION_${color}_SEAMLESS`, band(guideColor(capital(color))))
        for (const color of ['NEUTRAL', 'RED', 'YELLOW', 'PURPLE', 'CYAN'])
            add(`#GRID_${color}`, solid(guideColor(capital(color))))
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
            for (const [family] of slotFamilies) {
                add(`Sekai Slot ${family} ${color}`, image('slot', { color: accent }))
                add(`Sekai Slot Glow ${family} ${color}`, glow(accent))
            }
            for (const family of ['Normal', 'Critical'])
                add(`Sekai ${family} Slide Slot Glow ${color}`, glow(accent))
            for (const family of ['Flick', 'Critical Flick'])
                for (const [direction, key] of directions)
                    for (let width = 1; width <= 6; width++)
                        add(
                            `Sekai ${family} Arrow ${direction} ${width} ${color}`,
                            arrow(key, accent, width),
                        )
            const connection = connectorColor(color)
            for (const family of ['Normal', 'Critical']) {
                add(`Sekai ${family} Active Slide Connection Normal ${color}`, band(connection))
                add(
                    `Sekai ${family} Active Slide Connection Active ${color}`,
                    activeBand(connection),
                )
            }
            add(`Sekai Damage Slide Connection ${color}`, band(connection))
            add(`Sekai Damage Slide Connection Active ${color}`, activeBand(connection))
        }
    })

    return { sprites, groups }
}

/** The particle sprites, in the order the effects index them (sprite in particles.mjs). */
export const particleSprites = [
    ['glow', 'particle-glow'],
    ['frame', 'particle-frame'],
    ['star', 'particle-star'],
    ['spark', 'particle-spark'],
    ['comet', 'particle-comet'],
    ['bar', 'particle-bar'],
    ['flash', 'particle-flash'],
    ['mote', 'particle-circle'],
    ['diamond', 'particle-diamond'],
    ['thin', 'particle-frame-thin'],
    ['line', 'particle-frame-line'],
    ['beam', 'particle-beam'],
    ['streak', 'particle-streak'],
].map(([name, template]) => ({ name, spec: image(template, {}) }))

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

/** The metadata shared by the four items (Part 2, 2.3.5). */
export const itemMeta = {
    name: 'nse-builtin',
    title: 'Editor',
    subtitle: productName,
    author: `${productName} contributors`,
    description: `CC0 1.0. Version ${setVersion}.`,
}
