// Sprite names -> template and parameters, the particle table, the clip table and the item metadata.
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
    stage,
    styleColors,
    traceColors,
} from './palette.mjs'

/** The shown product name (Part 4, 4.1). */
export const productName = 'Next SEKAI Editor'

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
const band = (color, alpha) => image('band', { color, alpha }, { stretch: true })
const glow = (color) => image('slot-glow', { color }, { stretch: true })
const kite = (color, width) => image('kite', { color }, { width })

const capital = (word) => word[0].toUpperCase() + word.slice(1).toLowerCase()

const parts = ['Left', 'Middle', 'Right']
const bodyImage = (part, [outer, inner, accent]) =>
    image(
        `note-body-${part.toLowerCase()}`,
        { outer, inner, accent },
        { stretch: part === 'Middle' },
    )
const slimImage = (part, accent) =>
    image(`note-slim-${part.toLowerCase()}`, { accent }, { stretch: part === 'Middle' })
const damageImage = (part, color, edge) =>
    image(`note-damage-${part.toLowerCase()}`, { color, edge }, { stretch: part === 'Middle' })

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

    group('Judgment', () => {
        add('Sekai Judgment Background', solid('#ffffff', 0.1))
        for (const color of colorNames) {
            const hue = guideColor(color)
            add(`Sekai Judgment Background ${color}`, solid(hue, 0.12))
            add(
                `Sekai Judgment Gradient ${color}`,
                image('judgment-gradient', { color: hue }, { stretch: true }),
            )
            add(`Sekai Judgment Edge ${color}`, solid(hue, 0.8))
            add(`Sekai Judgment Single Line ${color}`, solid(hue, 0.9))
            add(
                `Sekai Judgment Edge Left ${color}`,
                image('judgment-edge-left', { color: hue }, { stretch: true }),
            )
            add(`Sekai Judgment Center ${color}`, solid(hue, 0.25))
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
                add(name, image('note-body-basic', { outer, inner, accent }))
            } else if (kind === 'damage')
                add(name, image('note-damage-basic', { color: damage.color, edge: damage.edge }))
            else add(name, image('note-slim-basic', { accent: traceColors[key] }))
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
                        image(template, { accent: color }),
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
            add(`Sekai ${family} Active Slide Connection Normal`, band(color, 0.45))
            add(`Sekai ${family} Active Slide Connection Active`, band(color, 0.75))
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
        add('Sekai Damage Slide Connection', band(damageColor, 0.45))
        add('Sekai Damage Slide Connection Active', band(damageColor, 0.75))
    })

    group('Guides', () => {
        for (const color of colorNames) add(`Sekai Guide ${color}`, solid(guideColor(color), 0.5))
    })

    group('Sim line', () => {
        add('#SIMULTANEOUS_CONNECTION_NEUTRAL', solid('#ffffff', 0.8))
    })

    group('Standard fallbacks', () => {
        for (const [color, key] of [
            ['CYAN', 'tap'],
            ['GREEN', 'slide'],
            ['RED', 'flick'],
            ['YELLOW', 'critical'],
        ]) {
            const [outer, inner, accent] = bodyColors[key]
            add(`#NOTE_HEAD_${color}`, image('note-body-basic', { outer, inner, accent }))
        }
        {
            const [outer, inner, accent] = styleColors('Purple')
            add('#NOTE_HEAD_PURPLE', image('note-body-basic', { outer, inner, accent }))
        }
        for (const key of ['green', 'red', 'yellow'])
            add(`#NOTE_TICK_${key.toUpperCase()}`, kite(diamondColors[key], 64))
        add('#DIRECTIONAL_MARKER_RED', image('arrow-up', { accent: arrowColors.normal }))
        add('#DIRECTIONAL_MARKER_YELLOW', image('arrow-up', { accent: arrowColors.critical }))
        for (const color of ['NEUTRAL', 'RED', 'GREEN', 'BLUE', 'YELLOW', 'PURPLE', 'CYAN'])
            add(`#NOTE_CONNECTION_${color}_SEAMLESS`, band(guideColor(capital(color)), 0.5))
        for (const color of ['NEUTRAL', 'RED', 'YELLOW', 'PURPLE', 'CYAN'])
            add(`#GRID_${color}`, solid(guideColor(capital(color)), 0.5))
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
                            image(template, { accent }),
                        )
            const connection = connectorColor(color)
            for (const family of ['Normal', 'Critical']) {
                add(
                    `Sekai ${family} Active Slide Connection Normal ${color}`,
                    band(connection, 0.45),
                )
                add(
                    `Sekai ${family} Active Slide Connection Active ${color}`,
                    band(connection, 0.75),
                )
            }
            add(`Sekai Damage Slide Connection ${color}`, band(connection, 0.45))
            add(`Sekai Damage Slide Connection Active ${color}`, band(connection, 0.75))
        }
    })

    return { sprites, groups }
}

/** The 8 particle sprites, in the order the effects index them. */
export const particleSprites = [
    ['ring', 'particle-ring'],
    ['circle', 'particle-circle'],
    ['square', 'particle-square'],
    ['diamond', 'particle-diamond'],
    ['chevron', 'particle-chevron'],
    ['bar', 'particle-bar'],
    ['streak', 'particle-streak'],
    ['flash', 'particle-flash'],
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
