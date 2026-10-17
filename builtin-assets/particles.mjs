// The particle effect table: every effect name with its kind and colour, and the groups of each kind.
// Effects are drawn in the engine's quad for their kind (-1 to 1; for linear and directional kinds y
// runs up from the judge line) over their own 0 to 1 progress; sprite indexes follow particleSprites
// in manifest.mjs. Particles blend normally, so a white-hot core is a white particle over a tinted
// one, and effect colours are the note colours made vivid for the dark stage.
// Weights follow the base set's ordering (work/assets/a1b2-design.md): critical flicks most, then
// critical taps, flicks, taps and slide ends, traces, slide ticks; no effect where it plays none.
import { bodyColors, colorNames, damageColor, mix, styleColors, vivid } from './palette.mjs'

const sprite = {
    glow: 0,
    frame: 1,
    star: 2,
    spark: 3,
    comet: 4,
    bar: 5,
    flash: 6,
    mote: 7,
    diamond: 8,
    thin: 9,
    line: 10,
    beam: 11,
    streak: 12,
}

const white = '#ffffff'

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

// A soft glow that swells and fades, centred at (0, y).
const bloom = (color, from, to, { y = 0, start = 0, duration = 1, alpha = 1 } = {}) =>
    particle({
        sprite: sprite.glow,
        color,
        start,
        duration,
        y: prop(y),
        ...size(from, to, 'outQuad'),
        a: prop(alpha, 0, 'inQuad'),
    })

// A diamond frame spreading flat on the stage, its alpha spent early (ease out), so it fades to a
// ghost rather than outlasting the hit. Paler than its colour, so neighbouring frames don't chain.
const frame = (
    color,
    from,
    to,
    { start = 0, duration = 1, alpha = 0.65, shape = sprite.thin, pale = 0.35 } = {},
) =>
    particle({
        sprite: shape,
        color: mix(color, white, pale),
        start,
        duration,
        ...size(from, to, 'outCubic'),
        a: prop(alpha, 0, 'outQuad'),
    })

// The white-hot start of a hit: a bright core at full alpha for about 0.1 s, then gone.
const core = (from, to, { duration = 0.2 } = {}) =>
    particle({
        sprite: sprite.glow,
        color: white,
        duration,
        ...size(from, to, 'outQuad'),
        a: prop(1, 0, 'inCubic'),
    })

// A four-point glint at the centre, turning a little as it shrinks.
const glint = (color, from, { duration = 1 } = {}) =>
    particle({
        sprite: sprite.star,
        color,
        duration,
        ...size(from, from * 0.25, 'inQuad'),
        r: prop(0, 0.5),
        a: prop(1, 0, 'inQuad'),
    })

// Small motes drifting out from the centre on random angles, on the plane of the effect.
const motes = (color, count, { from = 0.15, to = 0.5, radius = 0.02, duration = 1 } = {}) =>
    group(
        count,
        particle({
            sprite: sprite.mote,
            color,
            duration,
            x: prop({ cosr1: from }, { cosr1: to }, 'outCubic'),
            y: prop({ sinr1: from }, { sinr1: to }, 'outCubic'),
            ...size(radius),
            a: prop(1, 0, 'inQuad'),
        }),
    )

// Motes, needles or stars rising from the judge line across a band of the given half width.
const rising = (
    color,
    count,
    {
        shape = sprite.mote,
        spread = 0.5,
        height = 0.8,
        radius = 0.02,
        start = 0,
        duration = 1,
        spin = 0,
    } = {},
) =>
    group(
        count,
        particle({
            sprite: shape,
            color,
            start,
            duration,
            x: prop({ c: -spread, r1: 2 * spread }),
            y: prop({ c: -0.9, r3: 0.2 }, { c: -0.9 + height / 2, r2: height / 2 }, 'outCubic'),
            w: prop(shape === sprite.spark ? radius * 4 : radius),
            h: prop(radius),
            r: prop(
                shape === sprite.spark ? Math.PI / 2 : 0,
                shape === sprite.spark ? Math.PI / 2 : spin,
            ),
            a: prop(1, 0, 'inQuad'),
        }),
    )

// A soft vertical shaft of light standing on the judge line.
const shaft = (color, { width = 0.2, from = 0.2, to = 0.6, alpha = 0.8, duration = 1 } = {}) =>
    particle({
        sprite: sprite.bar,
        color,
        duration,
        y: prop(-1 + from, -1 + to, 'outQuad'),
        w: prop(width, width * 0.5),
        h: prop(from, to, 'outQuad'),
        a: prop(alpha, 0, 'inQuad'),
    })

// A comet thrown along the effect's y (the flick direction), turned by r and offset by x.
const comet = (
    color,
    {
        x = 0,
        r = 0,
        start = 0,
        duration = 1,
        from = -0.5,
        to = 0.9,
        length = 0.5,
        width = 0.1,
        alpha = 1,
        fade = 'inQuad',
        shape = sprite.comet,
    } = {},
) =>
    particle({
        sprite: shape,
        color,
        start,
        duration,
        x: prop(x, x - Math.sin(r) * (to - from)),
        y: prop(from, to, 'outCubic'),
        w: prop(width, width * 0.6),
        h: prop(length * 0.5, length, 'outQuad'),
        r: prop(r),
        a: prop(alpha, 0, fade),
    })

// The lane column: a short flash that collapses towards the judge line.
const laneFlash = (color, alpha, hold, fall) => [
    particle({ sprite: sprite.flash, color, duration: hold, a: prop(alpha) }),
    particle({
        sprite: sprite.flash,
        color,
        start: hold,
        duration: fall,
        y: prop(0, -0.5, 'outQuad'),
        h: prop(1, 0.5, 'outQuad'),
        a: prop(alpha, 0, 'outQuad'),
    }),
]

// Two halves of a loop, so a property eases there and back over one second.
const pulse = (base, from, to) =>
    [
        [from, to],
        [to, from],
    ].map(([a, b], half) => particle({ ...base(a, b), start: half / 2, duration: 0.5 }))

// The directional part of a flick, scaled for criticals: a white-hot fan of short comets opening
// off the note (peaking at about 0.1 s), then two thick beams, white in a coloured edge, thrown
// well past the square (strongest at 0.1 to 0.15 s), and motes.
const sweep = (color, { scale, motes: tail }) => [
    once(
        ...[-1.1, -0.55, 0, 0.55, 1.1].flatMap((r) =>
            [
                [color, 0.26, 0.8],
                [white, 0.13, 1],
            ].map(([tint, width, alpha]) =>
                comet(tint, {
                    r,
                    start: 0.08,
                    duration: 0.3,
                    from: -0.85,
                    to: r === 0 ? 0.05 : -0.35,
                    length: (r === 0 ? 0.8 : 0.65) * scale,
                    width: width * scale,
                    alpha,
                }),
            ),
        ),
        ...[
            [-0.25, 0.08, 0.24],
            [0.25, -0.08, 0.3],
        ].flatMap(([x, r, start]) =>
            [
                [color, 0.6],
                [white, 0.26],
            ].map(([tint, width]) =>
                comet(tint, {
                    x,
                    r,
                    start,
                    duration: 0.38,
                    from: 0,
                    to: 1.5 * scale,
                    length: 1.7 * scale,
                    width: width * scale,
                    fade: 'inCubic',
                    shape: sprite.beam,
                }),
            ),
        ),
    ),
    tail,
]

/** The groups of each kind of effect for one colour. */
export const kinds = {
    none: () => [],

    // Hits on the stage plane (3.5 lanes wide, 0.6 s): a white-hot core for the first 0.1 s over
    // a glow, then a thin pale diamond frame from 0.05 s, spreading flat and gone by about 0.3 s,
    // and white motes that stay clear of the frame.
    tapCircular: (color) => [
        once(
            bloom(color, 0.45, 0.8, { duration: 0.45, alpha: 0.8 }),
            core(0.3, 0.4),
            frame(color, 0.3, 0.8, { start: 0.08, duration: 0.42 }),
        ),
        motes(white, 6, { from: 0.3, to: 0.75, duration: 0.6 }),
    ],
    slideCircular: (color) => [
        once(
            bloom(color, 0.45, 0.8, { duration: 0.45, alpha: 0.8 }),
            core(0.3, 0.4),
            frame(color, 0.3, 0.8, { start: 0.08, duration: 0.42 }),
        ),
        motes(white, 4, { from: 0.3, to: 0.75, duration: 0.55 }),
    ],
    // Flicks carry their weight in the directional part; here a tap's hit with a flat glint.
    flickCircular: (color) => [
        once(
            bloom(color, 0.5, 0.85, { duration: 0.5, alpha: 0.85 }),
            core(0.32, 0.42),
            frame(color, 0.3, 0.85, { start: 0.08, duration: 0.42 }),
            glint(white, 0.45, { duration: 0.35 }),
        ),
        motes(white, 6, { from: 0.3, to: 0.8, duration: 0.6 }),
    ],
    criticalCircular: (color) => [
        once(
            bloom(color, 0.5, 0.9, { duration: 0.55, alpha: 0.85 }),
            core(0.34, 0.46, { duration: 0.22 }),
            frame(color, 0.3, 0.9, { start: 0.08, duration: 0.45 }),
            frame(color, 0.35, 1.2, { start: 0.15, duration: 0.45, alpha: 0.4 }),
        ),
        group(
            4,
            particle({
                sprite: sprite.star,
                color: white,
                duration: 0.7,
                x: prop({ cosr1: 0.6 }),
                y: prop({ sinr1: 0.6 }),
                ...size(0.14, 0.03, 'inQuad'),
                r: prop(0, 1),
                a: prop(1, 0, 'inQuad'),
            }),
        ),
        motes(white, 8, { from: 0.3, to: 0.95, duration: 0.75 }),
    ],
    // Critical slide ends: a tap's hit in gold, so with the critical shaft above it they sit
    // between a tap and a flick.
    criticalSlideCircular: (color) => [
        once(
            bloom(color, 0.45, 0.8, { duration: 0.45, alpha: 0.8 }),
            core(0.3, 0.4),
            frame(color, 0.3, 0.8, { start: 0.08, duration: 0.42 }),
        ),
        motes(white, 4, { from: 0.3, to: 0.75, duration: 0.55 }),
    ],

    // Above the note (2 lanes wide): next to nothing for a tap, needles for a flick, and for every
    // critical a tall shaft with stars rising far above it.
    tapLinear: () => [rising(white, 3, { spread: 0.4, height: 0.7, duration: 0.7 })],
    flickLinear: (color) => [
        once(shaft(color, { width: 0.3, to: 1.1, alpha: 0.75, duration: 0.65 })),
        rising(color, 6, {
            shape: sprite.spark,
            spread: 0.5,
            height: 1.4,
            radius: 0.045,
            duration: 0.7,
        }),
        rising(white, 2, { spread: 0.4, height: 0.9, duration: 0.7 }),
    ],
    criticalLinear: (color) => [
        once(
            shaft(color, { width: 0.3, from: 0.4, to: 1.9, alpha: 0.65, duration: 0.7 }),
            shaft(white, { width: 0.13, from: 0.3, to: 1.4, alpha: 0.7, duration: 0.45 }),
        ),
        rising(white, 6, {
            shape: sprite.star,
            spread: 0.7,
            height: 2.6,
            radius: 0.1,
            duration: 0.9,
            spin: 1.5,
        }),
        rising(color, 4, {
            shape: sprite.star,
            spread: 0.6,
            height: 2.2,
            radius: 0.085,
            duration: 0.8,
            spin: -1.5,
        }),
        rising(color, 5, {
            shape: sprite.spark,
            spread: 0.6,
            height: 2,
            radius: 0.035,
            duration: 0.7,
        }),
    ],

    // Flicks, in the linear square turned to the flick (y runs in the flick direction, 0.32 s): a
    // comet with a white-hot core sweeping off the note and a white fan either side of it, then
    // two thick white-cored beams thrown well past the square (the peak, 80 to 150 ms), and motes.
    directional: (color) =>
        sweep(color, {
            scale: 1,
            motes: rising(white, 4, { spread: 0.5, height: 1.6, duration: 0.8 }),
        }),
    criticalDirectional: (color) =>
        sweep(color, {
            scale: 1.06,
            motes: rising(white, 6, {
                shape: sprite.star,
                spread: 0.6,
                height: 1.8,
                radius: 0.08,
                duration: 0.85,
                spin: 1.5,
            }),
        }),
    // Lane columns (the lane quad, 1 s): a short flash collapsing to the line.
    lane: (color) => [
        once(
            ...laneFlash(color, 0.12, 0.1, 0.1),
            particle({ sprite: sprite.flash, color: white, duration: 0.1, a: prop(0.06, 0) }),
        ),
    ],
    // Critical flicks (and critical trace flicks, which share it). The engine plays it over the
    // lane from the judge line up (not below it) for 1 s: a gold flash, then a bright streak
    // shooting up the lane to its far end, its white head leading, the base set's convention.
    criticalFlickLane: (color) => [
        once(
            particle({ sprite: sprite.flash, color, duration: 0.06, a: prop(0.3, 0.12) }),
            particle({
                sprite: sprite.flash,
                color,
                start: 0.06,
                duration: 0.14,
                a: prop(0.12, 0, 'outQuad'),
            }),
            ...[
                [color, 1, 0.2, 0.6],
                [white, 0.5, 0.16, 0.85],
            ].map(([tint, width, height, alpha]) =>
                particle({
                    sprite: sprite.streak,
                    color: tint,
                    start: 0.05,
                    duration: 0.55,
                    y: prop(-0.8, 0.88, 'outSine'),
                    w: prop(width),
                    h: prop(height, height * 0.35),
                    a: prop(alpha, 0),
                }),
            ),
        ),
    ],
    // The standard lane effect (0.3 s).
    laneBasic: (color) => [once(particle({ sprite: sprite.flash, color, a: prop(0.35, 0) }))],

    // Traces, at the note (a square about four lanes across): a white glint, a hairline frame at
    // low alpha no wider than the note and gone by 0.25 s, and a little confetti; above it, a soft
    // low column and a few motes.
    traceTick: (color) => [
        once(
            bloom(color, 0.14, 0.24, { duration: 0.45, alpha: 0.8 }),
            glint(white, 0.18, { duration: 0.35 }),
            frame(color, 0.1, 0.32, {
                start: 0.05,
                duration: 0.37,
                alpha: 0.35,
                shape: sprite.line,
                pale: 0.2,
            }),
        ),
        group(
            6,
            particle({
                sprite: sprite.diamond,
                color,
                duration: 0.8,
                x: prop({ cosr1: 0.12 }, { cosr1: 0.4 }, 'outCubic'),
                y: prop({ sinr1: 0.12 }, { sinr1: 0.4, c: 0.08 }, 'outCubic'),
                ...size(0.02),
                a: prop(0.9, 0, 'inQuad'),
            }),
        ),
    ],
    traceLinear: (color) => [
        once(shaft(color, { width: 0.45, from: 0.25, to: 1.1, alpha: 0.5, duration: 0.65 })),
        rising(white, 6, { spread: 0.4, height: 1.2, radius: 0.02, duration: 0.8 }),
    ],
    // Slide ticks, the quietest hit: a small glint and a small frame.
    slideTick: (color) => [
        once(
            glint(white, 0.14, { duration: 0.35 }),
            frame(color, 0.06, 0.3, { duration: 0.5, alpha: 0.6 }),
        ),
    ],

    // Held slides (looped, 1 s, a quad twice the hit's): a calm glow and frame pulsing under the
    // finger, and motes rising above it; trails and slot motes behind a moving slide.
    holdCircular: (color) => [
        once(
            ...pulse(
                (a, b) => ({
                    sprite: sprite.glow,
                    color,
                    ...size(0.34 + 0.08 * a, 0.34 + 0.08 * b, 'inOutSine'),
                    a: prop(0.6 + 0.2 * a, 0.6 + 0.2 * b, 'inOutSine'),
                }),
                0,
                1,
            ),
            ...pulse(
                (a, b) => ({
                    sprite: sprite.frame,
                    color,
                    ...size(0.22 + 0.06 * a, 0.22 + 0.06 * b, 'inOutSine'),
                    a: prop(0.55 + 0.25 * a, 0.55 + 0.25 * b, 'inOutSine'),
                }),
                0,
                1,
            ),
            particle({ sprite: sprite.glow, color: white, ...size(0.1), a: prop(0.6) }),
        ),
    ],
    holdLinear: (color) => [
        once(
            particle({
                sprite: sprite.bar,
                color,
                y: prop(-0.3),
                w: prop(0.4),
                h: prop(0.8),
                a: prop(0.5),
            }),
        ),
        ...[0, 0.25, 0.5].map((start) =>
            rising(color, 3, { spread: 0.5, height: 1.4, radius: 0.03, start, duration: 0.5 }),
        ),
        rising(white, 2, { spread: 0.3, height: 1, radius: 0.015, start: 0.1, duration: 0.6 }),
    ],
    // Trails: a small burst of motes of a few sizes; slot motes: one soft glint rising.
    trail: (color) => [
        rising(color, 3, { spread: 0.4, height: 0.9, radius: 0.025 }),
        rising(white, 3, { spread: 0.3, height: 0.7, radius: 0.012, duration: 0.8 }),
    ],
    holdSlot: () => [
        once(
            particle({
                sprite: sprite.glow,
                color: white,
                duration: 0.8,
                y: prop(-0.9, -0.4, 'outCubic'),
                ...size(0.08, 0.04),
                a: prop(0.6, 0, 'inQuad'),
            }),
        ),
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

const circularOf = (family) =>
    family === 'Critical Slide'
        ? 'criticalSlideCircular'
        : family.startsWith('Critical')
          ? 'criticalCircular'
          : family.includes('Flick')
            ? 'flickCircular'
            : family === 'Slide'
              ? 'slideCircular'
              : 'tapCircular'
const linearOf = (family) =>
    family.startsWith('Critical')
        ? 'criticalLinear'
        : family.includes('Flick')
          ? 'flickLinear'
          : 'tapLinear'
const laneOf = (family) =>
    family.includes('Flick')
        ? family.startsWith('Critical')
            ? 'criticalFlickLane'
            : 'none'
        : 'lane'

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

    add('#LANE_LINEAR', 'laneBasic', '#ffffff')

    for (const name of hitFamilies) {
        family(`Sekai ${name} Note Circular`, circularOf(name))
        family(`Sekai ${name} Note Linear`, linearOf(name))
        // The base set plays no slot particles for notes.
        family(`Sekai ${name} Note Slot Linear`, 'none')
    }
    for (const name of laneFamilies) family(`Sekai ${name} Lane Linear`, laneOf(name))
    for (const name of ['Flick', 'Down Flick', 'Critical', 'Critical Down Flick'])
        family(
            `Sekai ${name} Note Directional`,
            name.startsWith('Critical') ? 'criticalDirectional' : 'directional',
        )
    // Avoiding a damage note is the goal, so nothing plays.
    family('Sekai Damage Note Circular', 'none')
    family('Sekai Damage Note Linear', 'none')
    family('Sekai Normal Slide Tick Note', 'slideTick')
    family('Sekai Critical Slide Tick Note', 'slideTick')
    family('Sekai Normal Trace Note Circular', 'traceTick', { plain: false })
    family('Sekai Normal Trace Note Linear', 'traceLinear', { plain: false })
    family('Sekai Critical Trace Note Circular', 'traceTick')
    family('Sekai Critical Trace Note Linear', 'traceLinear')
    add('Sekai Trace Note Circular', 'traceTick', accents.slide)
    add('Sekai Trace Note Circular Green', 'traceTick', accents.slide)
    add('Sekai Trace Note Circular Yellow', 'traceTick', accents.critical)
    add('Sekai Trace Note Linear', 'traceLinear', accents.slide)
    add('Sekai Trace Note Linear Green', 'traceLinear', accents.slide)
    add('Sekai Trace Note Linear Yellow', 'traceLinear', accents.critical)
    for (const name of ['Normal', 'Critical']) {
        family(`Sekai ${name} Slide Connector Circular`, 'holdCircular')
        family(`Sekai ${name} Slide Connector Linear`, 'holdLinear')
        family(`Sekai ${name} Slide Connector Trail Linear`, 'trail')
        family(`Sekai ${name} Slide Connector Slot Linear`, 'holdSlot')
        add(`Sekai ${name} Slide Trail Linear`, 'trail', plainColor(name))
    }

    // Older names the engine still declares.
    add('Sekai Critical Flick Circular Yellow', 'criticalCircular', accents.critical)
    add('Sekai Critical Flick Linear Yellow', 'criticalLinear', accents.critical)
    add('Sekai Critical Slide Circular Yellow', 'criticalSlideCircular', accents.critical)
    add('Sekai Critical Slide Linear Yellow', 'criticalLinear', accents.critical)
    for (const [name, color, kind] of [
        ['Alternative Red', accents.flick, 'none'],
        ['Alternative Yellow', accents.critical, 'none'],
        ['Slide Green', accents.slide, 'holdSlot'],
        ['Slide Yellow', accents.critical, 'holdSlot'],
        ['Slide Tap Yellow', accents.critical, 'none'],
        ['Tap Cyan', accents.tap, 'none'],
        ['Tap Green', accents.slide, 'none'],
        ['Tap Yellow', accents.critical, 'none'],
    ])
        add(`Sekai Slot Linear ${name}`, kind, color)

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
            const critical = color === 'YELLOW'
            const kindOf = (linear) => {
                if (group === 'HOLD') return linear ? 'holdLinear' : 'holdCircular'
                if (group === 'ALTERNATIVE')
                    return linear ? (critical ? 'criticalDirectional' : 'directional') : 'slideTick'
                if (critical) return linear ? 'criticalLinear' : 'criticalCircular'
                if (color === 'RED') return linear ? 'flickLinear' : 'flickCircular'
                return linear ? 'tapLinear' : 'tapCircular'
            }
            if (!(group === 'ALTERNATIVE' && color === 'GREEN'))
                add(`#NOTE_LINEAR_${group}_${color}`, kindOf(true), standardColors[color])
            if (!(group === 'ALTERNATIVE' && color === 'RED'))
                add(`#NOTE_CIRCULAR_${group}_${color}`, kindOf(false), standardColors[color])
        }

    return effects
}
