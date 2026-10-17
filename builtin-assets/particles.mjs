// The particle effect table: every effect name with its kind and colour, and the groups of each kind.
// Effects are drawn in a unit quad (-1 to 1) over their own 0 to 1 progress; sprite indexes follow
// particleSprites in manifest.mjs. Particles blend normally, so a white-hot core is a white particle
// over a tinted one, and effect colours are the note colours made vivid for the dark stage.
import { bodyColors, colorNames, damageColor, styleColors, vivid } from './palette.mjs'

const sprite = {
    ring: 0,
    circle: 1,
    square: 2,
    diamond: 3,
    chevron: 4,
    bar: 5,
    streak: 6,
    flash: 7,
    glow: 8,
    spark: 9,
    star: 10,
}

const white = '#ffffff'
const turn = 2 * Math.PI

const expression = (value) => (typeof value === 'number' ? { c: value } : value)
const prop = (from, to = from, ease = 'linear') => ({
    from: expression(from),
    to: expression(to),
    ease,
})
const size = (from, to = from, ease = 'linear') => ({
    w: prop(from, to, ease),
    h: prop(from, to, ease),
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

const group = (count, ...particles) => ({ count, particles })
const once = (...particles) => group(1, ...particles)

// A glow that swells and fades, centred at (0, y).
const bloom = (color, from, to, { y = 0, start = 0, duration = 1, alpha = 1 } = {}) =>
    particle({
        sprite: sprite.glow,
        color,
        start,
        duration,
        y: prop(y),
        ...size(from, to, 'outQuad'),
        a: prop(alpha, 0, 'outQuad'),
    })

const ring = (color, from, to, { start = 0, duration = 1 } = {}) =>
    particle({
        sprite: sprite.ring,
        color,
        start,
        duration,
        ...size(from, to, 'outCubic'),
        a: prop(1, 0, 'inQuad'),
    })

// Sparks flying out from the centre on random angles, pointing the way they fly.
const sparks = (color, count, { distance = 0.8, length = 0.12, duration = 1 } = {}) =>
    group(
        count,
        particle({
            sprite: sprite.spark,
            color,
            duration,
            x: prop(0, { cosr1: distance }, 'outCubic'),
            y: prop(0, { sinr1: distance }, 'outCubic'),
            w: prop(length, length / 3, 'outQuad'),
            h: prop(length / 3),
            r: prop({ r1: turn }),
            a: prop(1, 0, 'inQuad'),
        }),
    )

// Points of light rising from the judge line across a band of the given half width.
const rising = (
    color,
    count,
    { spread = 0.6, height = 0.8, length = 0.1, start = 0, duration = 1 } = {},
) =>
    group(
        count,
        particle({
            sprite: sprite.spark,
            color,
            start,
            duration,
            x: prop({ c: -spread, r1: 2 * spread }),
            y: prop(-0.9, { c: -0.9 + height / 2, r2: height / 2 }, 'outCubic'),
            w: prop(length, length / 3),
            h: prop(length / 4),
            r: prop(Math.PI / 2),
            a: prop(1, 0, 'inQuad'),
        }),
    )

// A light flare along the judge line.
const flare = (color, width, { thickness = 0.07, duration = 1 } = {}) =>
    particle({
        sprite: sprite.streak,
        color,
        duration,
        y: prop(-0.95),
        w: prop(width * 0.2, width, 'outQuad'),
        h: prop(thickness),
        a: prop(1, 0, 'inQuad'),
    })

// White four-point stars scattered round the centre.
const stars = (count, spread, { start = 0, duration = 0.7 } = {}) =>
    group(
        count,
        particle({
            sprite: sprite.star,
            color: white,
            start,
            duration,
            x: prop({ cosr1: spread }),
            y: prop({ sinr1: spread }),
            ...size(0.13, 0, 'inQuad'),
            r: prop(0, 1.2),
            a: prop(1, 0.6),
        }),
    )

// A glow pulsing between two sizes over the loop.
const pulse = (color, small, large, low, high, { y = 0, w = 1, h = 1 } = {}) =>
    [
        [small, large, low, high],
        [large, small, high, low],
    ].map(([from, to, a, b], half) =>
        particle({
            sprite: sprite.glow,
            color,
            start: half / 2,
            duration: 0.5,
            y: prop(y),
            w: prop(from * w, to * w, 'inOutSine'),
            h: prop(from * h, to * h, 'inOutSine'),
            a: prop(a, b, 'inOutSine'),
        }),
    )

/** The groups of each kind of effect for one colour. */
export const kinds = {
    // Hits, on the stage plane round the note: a flash, a ring and sparks.
    circular: (color) => [
        once(
            bloom(color, 0.35, 0.7, { duration: 0.7 }),
            ring(color, 0.2, 0.7, { duration: 0.45 }),
            bloom(white, 0.2, 0.36, { duration: 0.35 }),
        ),
        sparks(color, 8, { length: 0.2, duration: 0.6 }),
        sparks(white, 4, { distance: 0.6, length: 0.14, duration: 0.45 }),
    ],
    criticalCircular: (color) => [
        once(
            bloom(color, 0.4, 0.85, { duration: 0.8 }),
            ring(color, 0.2, 0.8, { duration: 0.5 }),
            ring(white, 0.15, 0.6, { start: 0.15, duration: 0.5 }),
            bloom(white, 0.24, 0.42, { duration: 0.4 }),
        ),
        sparks(color, 12, { distance: 0.95, length: 0.24, duration: 0.7 }),
        sparks(white, 6, { distance: 0.7, length: 0.16, duration: 0.5 }),
        stars(4, 0.45, { start: 0.05 }),
    ],
    // Hits, above the note: a shaft of light, a flare on the line and rising sparks.
    linear: (color) => [
        once(
            particle({
                sprite: sprite.bar,
                color,
                duration: 0.8,
                y: prop(-0.85, -0.4, 'outQuad'),
                w: prop(0.22, 0.08),
                h: prop(0.15, 0.6, 'outQuad'),
                a: prop(0.85, 0, 'outQuad'),
            }),
            flare(color, 1, { thickness: 0.12, duration: 0.7 }),
            flare(white, 0.8, { duration: 0.45 }),
        ),
        rising(color, 6, { duration: 0.75 }),
        rising(white, 3, { spread: 0.4, height: 0.6, length: 0.08, duration: 0.5 }),
    ],
    // Flicks, in a square turned to the flick: chevrons and speed lines moving that way.
    directional: (color) => [
        once(
            bloom(color, 0.3, 0.5, { y: -0.8, duration: 0.6, alpha: 0.8 }),
            ...[0, 0.12, 0.24].flatMap((start) => [
                particle({
                    sprite: sprite.chevron,
                    color,
                    start,
                    duration: 0.65,
                    y: prop(-0.5, 0.8, 'outQuad'),
                    w: prop(0.34, 0.26),
                    h: prop(0.17, 0.13),
                    a: prop(1, 0, 'inQuad'),
                }),
                particle({
                    sprite: sprite.chevron,
                    color: white,
                    start,
                    duration: 0.45,
                    y: prop(-0.5, 0.5, 'outQuad'),
                    w: prop(0.2, 0.14),
                    h: prop(0.1, 0.07),
                    a: prop(0.9, 0, 'inQuad'),
                }),
            ]),
        ),
        rising(white, 6, { spread: 0.5, height: 1.6, length: 0.2, duration: 0.7 }),
    ],
    // Lane flashes: a short burst that drops back to the line (the lane quad, 1 s).
    lane: (color) => [
        once(
            particle({ sprite: sprite.flash, color, duration: 0.08, a: prop(0.75) }),
            particle({
                sprite: sprite.flash,
                color,
                start: 0.08,
                duration: 0.17,
                y: prop(0, -0.4, 'outQuad'),
                h: prop(1, 0.6, 'outQuad'),
                a: prop(0.75, 0, 'outQuad'),
            }),
            particle({ sprite: sprite.flash, color: white, duration: 0.12, a: prop(0.3, 0) }),
        ),
    ],
    // The standard lane effect (0.3 s).
    laneBasic: (color) => [once(particle({ sprite: sprite.flash, color, a: prop(0.5, 0) }))],
    // One per lane under the note: a short shaft from the slot and two motes.
    slotLinear: (color) => [
        once(
            particle({
                sprite: sprite.bar,
                color,
                duration: 0.6,
                y: prop(-0.95, -0.6, 'outQuad'),
                w: prop(0.4, 0.3),
                h: prop(0.08, 0.35, 'outQuad'),
                a: prop(0.8, 0, 'outQuad'),
            }),
        ),
        rising(white, 2, { spread: 0.3, height: 0.6, length: 0.07, duration: 0.7 }),
    ],
    // Ticks and traces, at the note (a square about ten lanes across): a glint over a small pop.
    tick: (color) => [
        once(
            bloom(color, 0.1, 0.2, { duration: 0.6, alpha: 0.9 }),
            ring(color, 0.05, 0.2, { duration: 0.5 }),
            particle({
                sprite: sprite.diamond,
                color,
                duration: 0.5,
                ...size(0.06, 0.1, 'outQuad'),
                a: prop(1, 0, 'inQuad'),
            }),
            particle({
                sprite: sprite.star,
                color: white,
                duration: 0.5,
                ...size(0.16, 0.04, 'outQuad'),
                r: prop(0, 0.6),
                a: prop(1, 0, 'inQuad'),
            }),
        ),
        sparks(color, 6, { distance: 0.25, length: 0.06, duration: 0.6 }),
    ],
    traceLinear: (color) => [
        once(
            flare(color, 0.45, { thickness: 0.08, duration: 0.6 }),
            flare(white, 0.3, { thickness: 0.04, duration: 0.4 }),
        ),
        rising(color, 4, { spread: 0.25, height: 0.5, length: 0.07, duration: 0.6 }),
    ],
    // Held slides (looped, 1 s, a quad twice the hit's): a pulsing glow, a slow ring, sparkles.
    holdCircular: (color) => [
        once(
            ...pulse(color, 0.12, 0.16, 0.7, 0.9),
            ring(color, 0.06, 0.22),
            particle({ sprite: sprite.glow, color: white, ...size(0.07), a: prop(0.8) }),
        ),
        ...[0, 0.5].map((start) => stars(2, 0.14, { start, duration: 0.5 })),
    ],
    // Held slides, above the note: a steady shaft over a pulsing base and rising motes.
    holdLinear: (color) => [
        once(
            particle({
                sprite: sprite.bar,
                color,
                y: prop(-0.5),
                w: prop(0.12),
                h: prop(0.5),
                a: prop(0.35),
            }),
            ...pulse(color, 1, 1.1, 0.6, 0.85, { y: -0.95, w: 0.45, h: 0.2 }),
        ),
        ...[0, 0.25, 0.5].map((start) =>
            rising(color, 2, { spread: 0.4, height: 1, length: 0.08, start, duration: 0.5 }),
        ),
        rising(white, 2, { spread: 0.3, height: 0.8, length: 0.06, start: 0.1, duration: 0.6 }),
    ],
    // Moving slides leave motes rising behind them.
    trail: (color) => [
        rising(color, 3, { spread: 0.5, height: 0.9, length: 0.08 }),
        rising(white, 1, { spread: 0.3, height: 0.6, length: 0.06, duration: 0.7 }),
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
        effects.push({ name, kind, color: vivid(color) })
    }
    // The plain name with the plain colour, and then one per style colour.
    const family = (name, kind, { plain = true } = {}) => {
        if (plain) add(name, kind, plainColor(name))
        for (const color of colorNames) add(`${name} ${color}`, kind, styleEffectColor(color))
    }
    const circular = (name) => (name.includes('Critical') ? 'criticalCircular' : 'circular')

    add('#LANE_LINEAR', 'laneBasic', '#ffffff')

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
