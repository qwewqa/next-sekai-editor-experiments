// Sprite names -> template and parameters, the particle table, the clip table and the item metadata.
import product from '../src/product.json' with { type: 'json' }
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
const glow = (color) =>
    image('slot-glow', { color, light: mix(color, '#ffffff', 0.5) }, { stretch: true })
const kite = (color, width) => image('kite', { color }, { width, transform: kiteBox(width) })

// The dark base of the judgment band.
const judgmentShade = '#0b0c16'

/**
 * A sprite transform that draws the sprite's frame over the box [u0, u1] x [v0, v1] of the engine's
 * quad (0 to 1 from its bottom-left corner), so the art lands where the base skin's does on screen.
 */
export function box(u0, u1, v0, v1) {
    const corner = (u, v) => ({ 1: 1 - u - v, 4: u, 2: v })
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

// The box for art that fills its frame but for a margin m on each side.
const fit = (u0, u1, v0, v1, m) => {
    const w = (u1 - u0) / (1 - 2 * m)
    const h = (v1 - v0) / (1 - 2 * m)
    return box(u0 - m * w, u0 - m * w + w, v0 - m * h, v0 - m * h + h)
}

// Where the base skin's flick arrows land in the engine's arrow square, by direction and width
// (1 to 6): [u0, u1, v0, v1]. Narrow notes get large, tall arrows; wide notes flat ones.
const arrowBoxes = {
    up: [
        [-0.14, 1.14, 0.25, 1.61],
        [-0.09, 1.09, 0.17, 1.21],
        [-0.07, 1.07, 0.11, 0.94],
        [-0.05, 1.05, 0.09, 0.79],
        [-0.04, 1.04, 0.07, 0.7],
        [-0.03, 1.03, 0.06, 0.64],
    ],
    upLeft: [
        [-0.32, 1.32, 0.27, 1.66],
        [-0.24, 1.21, 0.2, 1.27],
        [-0.19, 1.15, 0.15, 1.03],
        [-0.17, 1.12, 0.11, 0.89],
        [-0.15, 1.1, 0.08, 0.81],
        [-0.13, 1.09, 0.07, 0.75],
    ],
    down: [
        [-0.14, 1.14, 0.18, 1.55],
        [-0.09, 1.09, 0.11, 1.15],
        [-0.07, 1.07, 0.07, 0.9],
        [-0.05, 1.05, 0.05, 0.76],
        [-0.04, 1.04, 0.04, 0.67],
        [-0.03, 1.03, 0.04, 0.62],
    ],
    downLeft: [
        [-0.32, 1.32, 0.16, 1.55],
        [-0.24, 1.21, 0.11, 1.18],
        [-0.19, 1.15, 0.07, 0.96],
        [-0.17, 1.12, 0.05, 0.84],
        [-0.15, 1.1, 0.04, 0.77],
        [-0.13, 1.09, 0.04, 0.72],
    ],
}
const arrowKeys = {
    'arrow-up': 'up',
    'arrow-up-left': 'upLeft',
    'arrow-down': 'down',
    'arrow-down-left': 'downLeft',
}
const arrow = (template, accent, width) =>
    image(
        template,
        { accent },
        { transform: fit(...arrowBoxes[arrowKeys[template]][width - 1], 0.03) },
    )

// Note bodies sit 6% over and under their quad and their ends reach 0.14 of a slice past the note,
// as the base skin's do; slim traces keep their own height in the art.
const bodyBox = {
    Left: box(-0.14, 1, -0.06, 1.06),
    Middle: box(0, 1, -0.06, 1.06),
    Right: box(0, 1.14, -0.06, 1.06),
}
const slimBox = { Left: box(-0.14, 1, 0, 1), Middle: undefined, Right: box(0, 1.14, 0, 1) }
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
    ['Up', 'arrow-up'],
    ['Up Left', 'arrow-up-left'],
    ['Down', 'arrow-down'],
    ['Down Left', 'arrow-down-left'],
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
        add('Sekai Lane Background', solid(stage.lane, 0.8, 4, 64))
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
            for (const [direction, template] of directions)
                for (let width = 1; width <= 6; width++)
                    add(
                        `Sekai ${family} Arrow ${direction} ${width}`,
                        arrow(template, color, width),
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
        for (const [family, color] of [
            ['Normal', activeColors.normal],
            ['Critical', activeColors.critical],
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
        add('#DIRECTIONAL_MARKER_RED', image('arrow-up', { accent: arrowColors.normal }))
        add('#DIRECTIONAL_MARKER_YELLOW', image('arrow-up', { accent: arrowColors.critical }))
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
                for (const [direction, template] of directions)
                    for (let width = 1; width <= 6; width++)
                        add(
                            `Sekai ${family} Arrow ${direction} ${width} ${color}`,
                            arrow(template, accent, width),
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
