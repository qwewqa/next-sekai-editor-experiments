// The particle effect table: every effect name with its kind and colour, and the groups of each kind.
// Effects are drawn in a unit quad (-1 to 1) over their own 0 to 1 progress; sprite indexes follow
// particleSprites in manifest.mjs.
import { bodyColors, colorNames, damageColor, styleColors } from './palette.mjs'

const sprite = {
    ring: 0,
    circle: 1,
    square: 2,
    diamond: 3,
    chevron: 4,
    bar: 5,
    streak: 6,
    flash: 7,
}

const expression = (value) => (typeof value === 'number' ? { c: value } : value)
const prop = (from, to = from, ease = 'linear') => ({
    from: expression(from),
    to: expression(to),
    ease,
})

const particle = ({ sprite: index, color, start = 0, duration = 1, x, y, w, h, r, a }) => ({
    sprite: index,
    color,
    start,
    duration,
    x: x ?? prop(0),
    y: y ?? prop(0),
    w: w ?? prop(1),
    h: h ?? prop(1),
    r: r ?? prop(0),
    a: a ?? prop(1, 0),
})

// Small squares or dots flying out on random angles.
const burst = (index, color, count, size, distance) => ({
    count,
    particles: [
        particle({
            sprite: index,
            color,
            x: prop(0, { cosr1: distance }, 'outQuad'),
            y: prop(0, { sinr1: distance }, 'outQuad'),
            w: prop(size, size / 3),
            h: prop(size, size / 3),
            r: prop(0, { r2: 3 }),
            a: prop(1, 0, 'inQuad'),
        }),
    ],
})

const ring = (color, from, to, start = 0, duration = 1) => ({
    count: 1,
    particles: [
        particle({
            sprite: sprite.ring,
            color,
            start,
            duration,
            w: prop(from, to, 'outQuad'),
            h: prop(from, to, 'outQuad'),
            a: prop(1, 0, 'inQuad'),
        }),
    ],
})

/** The groups of each kind of effect for one colour. */
export const kinds = {
    circular: (color) => [ring(color, 0.3, 0.75), burst(sprite.square, color, 6, 0.07, 0.7)],
    criticalCircular: (color) => [
        ring(color, 0.3, 0.75),
        ring(color, 0.2, 0.6, 0.2, 0.8),
        burst(sprite.square, color, 6, 0.07, 0.7),
    ],
    linear: (color) => [
        {
            count: 1,
            particles: [
                particle({
                    sprite: sprite.streak,
                    color,
                    y: prop(-0.85, -0.6, 'outQuad'),
                    w: prop(0.1, 0.9, 'outQuad'),
                    h: prop(0.06),
                }),
            ],
        },
    ],
    directional: (color) => [
        {
            count: 1,
            particles: [0, 0.1, 0.2].map((start) =>
                particle({
                    sprite: sprite.chevron,
                    color,
                    start,
                    duration: 0.7,
                    y: prop(-0.6, 0.9, 'outQuad'),
                    w: prop(0.25),
                    h: prop(0.12),
                    a: prop(1, 0, 'inQuad'),
                }),
            ),
        },
    ],
    lane: (color) => [
        {
            count: 1,
            particles: [particle({ sprite: sprite.flash, color, a: prop(0.5, 0) })],
        },
    ],
    slotLinear: (color) => [
        {
            count: 1,
            particles: [
                particle({
                    sprite: sprite.bar,
                    color,
                    y: prop(-0.6, 0.4, 'outQuad'),
                    w: prop(0.4),
                    h: prop(0.5),
                    a: prop(0.8, 0, 'outQuad'),
                }),
            ],
        },
    ],
    tick: (color) => [
        {
            count: 1,
            particles: [
                particle({
                    sprite: sprite.diamond,
                    color,
                    w: prop(0.2, 0.4, 'outQuad'),
                    h: prop(0.2, 0.4, 'outQuad'),
                    a: prop(1, 0, 'inQuad'),
                }),
            ],
        },
        burst(sprite.circle, color, 4, 0.06, 0.7),
    ],
    traceLinear: (color) => [
        {
            count: 1,
            particles: [
                particle({
                    sprite: sprite.streak,
                    color,
                    y: prop(-0.85, -0.7, 'outQuad'),
                    w: prop(0.1, 0.35, 'outQuad'),
                    h: prop(0.05),
                }),
            ],
        },
    ],
    holdCircular: (color) => [
        {
            count: 1,
            particles: [
                particle({
                    sprite: sprite.ring,
                    color,
                    w: prop(0.35, 0.5, 'inOutSine'),
                    h: prop(0.35, 0.5, 'inOutSine'),
                    a: prop(0.8, 0.3),
                }),
            ],
        },
        {
            count: 3,
            particles: [
                particle({
                    sprite: sprite.square,
                    color,
                    x: prop({ c: -0.5, r1: 1 }),
                    y: prop(-0.3, { c: 0.7, r2: 0.2 }),
                    w: prop(0.05),
                    h: prop(0.05),
                    a: prop(1, 0, 'inQuad'),
                }),
            ],
        },
    ],
    holdLinear: (color) => [
        {
            count: 1,
            particles: [
                particle({
                    sprite: sprite.bar,
                    color,
                    w: prop(0.3),
                    h: prop(0.9),
                    a: prop(0.6, 0.2, 'inOutSine'),
                }),
            ],
        },
    ],
    trail: (color) => [
        {
            count: 4,
            particles: [
                particle({
                    sprite: sprite.square,
                    color,
                    x: prop({ c: -0.6, r1: 1.2 }),
                    y: prop(-0.9, { c: 0.2, r2: 0.3 }, 'outQuad'),
                    w: prop(0.05),
                    h: prop(0.05),
                    a: prop(1, 0, 'inQuad'),
                }),
            ],
        },
    ],
}

const accents = {
    tap: bodyColors.tap[2],
    slide: bodyColors.slide[2],
    flick: bodyColors.flick[2],
    critical: bodyColors.critical[2],
    damage: damageColor,
    purple: styleColors('Purple')[2],
}

/** A style colour's effect colour; black uses its lighter grey so it stays visible. */
const styleEffectColor = (name) => styleColors(name)[name === 'Black' ? 1 : 2]

const plainColor = (name) => {
    if (name.includes('Damage')) return accents.damage
    if (name.includes('Critical')) return accents.critical
    if (name.includes('Flick')) return accents.flick
    if (name.includes('Slide') || name.includes('Trace')) return accents.slide
    return accents.tap
}

const hitFamilies = [
    'Normal',
    'Slide',
    'Flick',
    'Down Flick',
    'Critical',
    'Critical Slide',
    'Critical Flick',
    'Critical Down Flick',
]
const laneFamilies = hitFamilies.map((family) => (family === 'Normal' ? 'Note' : family))

/** Every effect: { name, kind, color }, in a fixed order. */
export function particleEffects() {
    const effects = []
    const names = new Set()
    const add = (name, kind, color) => {
        if (names.has(name)) throw new Error(`Duplicate particle effect name: ${name}`)
        names.add(name)
        effects.push({ name, kind, color })
    }
    // The plain name with the plain colour, and then one per style colour.
    const family = (name, kind, { plain = true } = {}) => {
        if (plain) add(name, kind, plainColor(name))
        for (const color of colorNames) add(`${name} ${color}`, kind, styleEffectColor(color))
    }
    const circular = (name) => (name.includes('Critical') ? 'criticalCircular' : 'circular')

    add('#LANE_LINEAR', 'lane', '#ffffff')

    for (const name of hitFamilies) {
        family(`Sekai ${name} Note Circular`, circular(name))
        family(`Sekai ${name} Note Linear`, 'linear')
        family(`Sekai ${name} Note Slot Linear`, 'slotLinear')
    }
    for (const name of laneFamilies) family(`Sekai ${name} Lane Linear`, 'lane')
    for (const name of ['Flick', 'Down Flick', 'Critical', 'Critical Down Flick'])
        family(`Sekai ${name} Note Directional`, 'directional')
    family('Sekai Damage Note Circular', 'circular')
    family('Sekai Damage Note Linear', 'linear')
    family('Sekai Normal Slide Tick Note', 'tick')
    family('Sekai Critical Slide Tick Note', 'tick')
    family('Sekai Normal Trace Note Circular', 'tick', { plain: false })
    family('Sekai Normal Trace Note Linear', 'traceLinear', { plain: false })
    family('Sekai Critical Trace Note Circular', 'tick')
    family('Sekai Critical Trace Note Linear', 'traceLinear')
    add('Sekai Trace Note Circular', 'tick', accents.slide)
    add('Sekai Trace Note Circular Green', 'tick', accents.slide)
    add('Sekai Trace Note Circular Yellow', 'tick', accents.critical)
    add('Sekai Trace Note Linear', 'traceLinear', accents.slide)
    add('Sekai Trace Note Linear Green', 'traceLinear', accents.slide)
    add('Sekai Trace Note Linear Yellow', 'traceLinear', accents.critical)
    for (const name of ['Normal', 'Critical']) {
        family(`Sekai ${name} Slide Connector Circular`, 'holdCircular')
        family(`Sekai ${name} Slide Connector Linear`, 'holdLinear')
        family(`Sekai ${name} Slide Connector Trail Linear`, 'trail')
        family(`Sekai ${name} Slide Connector Slot Linear`, 'slotLinear')
        add(`Sekai ${name} Slide Trail Linear`, 'trail', plainColor(name))
    }

    // Older names the engine still declares.
    add('Sekai Critical Flick Circular Yellow', 'criticalCircular', accents.critical)
    add('Sekai Critical Flick Linear Yellow', 'linear', accents.critical)
    add('Sekai Critical Slide Circular Yellow', 'criticalCircular', accents.critical)
    add('Sekai Critical Slide Linear Yellow', 'linear', accents.critical)
    for (const [name, color] of [
        ['Alternative Red', accents.flick],
        ['Alternative Yellow', accents.critical],
        ['Slide Green', accents.slide],
        ['Slide Yellow', accents.critical],
        ['Slide Tap Yellow', accents.critical],
        ['Tap Cyan', accents.tap],
        ['Tap Green', accents.slide],
        ['Tap Yellow', accents.critical],
    ])
        add(`Sekai Slot Linear ${name}`, 'slotLinear', color)

    // The standard names.
    const standard = [
        ['TAP', ['CYAN', 'GREEN', 'PURPLE', 'RED', 'YELLOW']],
        ['ALTERNATIVE', ['GREEN', 'RED', 'YELLOW']],
        ['HOLD', ['GREEN', 'YELLOW']],
    ]
    const standardColors = {
        CYAN: accents.tap,
        GREEN: accents.slide,
        PURPLE: accents.purple,
        RED: accents.flick,
        YELLOW: accents.critical,
    }
    for (const [group, colors] of standard)
        for (const color of colors) {
            const hold = group === 'HOLD'
            const alternative = group === 'ALTERNATIVE'
            if (!(alternative && color === 'GREEN'))
                add(
                    `#NOTE_LINEAR_${group}_${color}`,
                    alternative ? 'directional' : hold ? 'holdLinear' : 'linear',
                    standardColors[color],
                )
            if (!(alternative && color === 'RED'))
                add(
                    `#NOTE_CIRCULAR_${group}_${color}`,
                    alternative ? 'tick' : hold ? 'holdCircular' : circular(color),
                    standardColors[color],
                )
        }

    return effects
}
