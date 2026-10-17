// The particle effect table: every effect name with its kind and colour, and the groups of each kind.
// Effects are drawn in the engine's quad for their kind (-1 to 1; for linear and directional kinds y
// runs up from the judge line at -1, one unit a lane) over their own 0 to 1 progress; sprite indexes
// follow particleSprites in manifest.mjs. Particles blend normally, so a white-hot core is a white
// particle over a tinted one.
// Each kind works like the base set's effect of the same role (Next SEKAI 01, work/assets/a1b5.md):
// the same groups and counts, the same motion (where each part starts, how it moves, grows and
// fades), drawn with our own sprites of the same kind. Streams of small particles stay streams;
// fixed placements (bursts, fans, confetti rings) are generated here rather than copied.
import {
    baseColors,
    bodyColors,
    colorNames,
    damageColor,
    mix,
    styleColors,
    vivid,
} from './palette.mjs'

const sprite = {
    glow: 0,
    halo: 1,
    frame: 2,
    line: 3,
    plate: 4,
    flare: 5,
    sparkle: 6,
    mote: 7,
    shard: 8,
    arc: 9,
    flame: 10,
    needle: 11,
    ring: 12,
    wisp: 13,
    fan: 14,
    flash: 15,
    streak: 16,
}

const white = '#ffffff'
const pale = (color, amount) => mix(color, white, amount)
const round = (value) => Math.round(value * 1000) / 1000

const expression = (value) => (typeof value === 'number' ? { c: round(value) } : value)
const prop = (from, to = from, ease = 'linear') => ({
    from: expression(from),
    to: expression(to),
    ease,
})
// A property: a value, [from, to] or [from, to, ease].
const value = (spec) => (Array.isArray(spec) ? prop(...spec) : prop(spec))

/** One particle: sprite name, tint, start and duration (of the effect), and its properties. */
const pt = (name, color, start, duration, { x = 0, y = 0, w = 1, h = w, r = 0, a = [1, 0] }) => ({
    sprite: sprite[name],
    color,
    start: round(start),
    duration: round(duration),
    x: value(x),
    y: value(y),
    w: value(w),
    h: value(h),
    r: value(r),
    a: value(a),
})

const group = (count, ...particles) => ({ count, particles })
const once = (...particles) => group(1, ...particles)

// A fixed, well spread sequence in [0, 1) for generated placements.
const spread = (k, stream = 0) => (k * 0.6180339887 + stream * 0.4142135624) % 1

// Our own sparkle colours: white, the effect colour paled, and a lighter tint.
const sparkleTints = (color) => [white, pale(color, 0.3), white, pale(color, 0.6)]

// Linear effects stand on the judge line in a square two lanes wide; y = -1 is the line.

// Thin shards shooting up from just under the line, shortening as they slow.
const shards = (color, alpha = 0.7) =>
    pt('shard', color, 0.033, 0.6, {
        x: { cosr1: 0.4 },
        y: [{ c: -1.3, sinr1: 0.3 }, { c: 1.3, r2: 2, sinr1: 1.5 }, 'outCubic'],
        w: { r3: 0.1 },
        h: [{ c: 0.1, r4: 0.2 }, { r3: 0.1 }],
        a: [alpha, 0],
    })
// Fine dust over the column, drifting up a little.
const dust = (color, { alpha = 0.9, fade = 'linear', spreadX = 0.8, radius = 0.025 } = {}) =>
    pt('mote', color, 0.033, 0.6, {
        x: { sinr5: spreadX },
        y: [{ c: 0.4, sinr1: 1.8 }, { c: 1, sinr1: 2 }, 'outCubic'],
        w: radius,
        a: [alpha, 0, fade],
    })
// A soft column of light (a stretched glow: no edges).
const column = (color, { start = 0, duration, y = 0, w, h, alpha, fade = 'linear' }) =>
    pt('glow', color, start, duration, { y, w, h, a: [alpha, 0, fade] })
// A soft arc of light rising off the line and opening wide.
const arc = (color, { duration, ease, alpha, fade }) =>
    pt('arc', color, 0.033, duration, {
        y: [-1.3, 0.5, ease],
        w: [0, 3.3, ease],
        h: [0, 1.8, ease],
        a: [alpha, 0, fade],
    })

// Shards thrown out round the note in every direction, each along its own direction.
const burst = (color, count) =>
    Array.from({ length: count }, (_, k) => {
        const angle = (2 * Math.PI * (k + 0.6 * spread(k, 1))) / count
        const near = 0.3 + 1.2 * spread(k, 2)
        const far = near * (1.5 + 0.5 * spread(k, 3))
        const length = 0.25 + 0.8 * spread(k, 4)
        const [c, s] = [Math.cos(angle), Math.sin(angle) * 0.8]
        return pt('shard', color, 0.033, 0.835, {
            x: [near * c, far * c, 'outQuad'],
            y: [-1 + near * s, -1 + far * s, 'outQuad'],
            w: [length, length * 0.08, 'outCubic'],
            h: [0.04 + 0.06 * spread(k, 5), 0.015, 'outCubic'],
            r: round(angle),
            a: [1, 0],
        })
    })

// Sparkles bursting from under the note, two of each tint per copy.
const sparkleBurst = (color) =>
    sparkleTints(color).map((tint, k) =>
        pt('sparkle', tint, 0, 0.8 + 0.066 * k, {
            x: [0, { c: -0.3 + 0.2 * k, r1: 1.4 - 0.5 * k, r2: k % 2 ? 0.9 : -0.9, sinr1: -0.8 }],
            y: [-1, { r1: 1.8 - 0.6 * k, r2: -1.5 + 0.8 * k, sinr1: 0.9, sinr2: 1.5 - 0.3 * k }],
            w: [{ c: 0.1, r1: 0.2 }, 0],
            a: [1, 0, 'inQuad'],
        }),
    )

// The flame of a flick: a wide flash at the note, then a long beam thrown along the flick, white
// in a coloured edge.
const flame = (color) =>
    [
        [pale(color, 0.2), 1],
        [white, 0.45],
    ].flatMap(([tint, k]) => [
        pt('flame', tint, 0.167, 0.222, {
            y: [-1.2, -0.3, 'outQuad'],
            w: [0, 2.3 * k, 'outQuad'],
            h: [0, 0.9, 'outQuad'],
            a: 1,
        }),
        pt('flame', tint, 0.399, 0.056, {
            y: [-0.3, -0.23],
            w: [2.3 * k, 1.9 * k],
            h: [0.9, 1.1],
            a: 1,
        }),
        pt('flame', tint, 0.455, 0.5, {
            y: [2.25, 6, 'inQuad'],
            w: [0.7 * k, 0, 'outQuad'],
            h: [4, 0, 'outQuad'],
            a: [1, 0],
        }),
    ])

// Motes flickering out along the flick after the flame: up the middle, out to the sides, back.
const flickers = (color) =>
    [
        [
            15,
            { sinr5: 0.4 },
            { sinr5: 0.4 },
            { c: -1.3, sinr1: 0.3 },
            { c: 2.3, r2: 2, sinr1: 2.3 },
        ],
        [20, { sinr5: 0.45 }, { sinr5: 2.5 }, -1.3, { c: 0.3, r2: 0.3, sinr1: 0.5 }],
        [8, { sinr5: 0.45 }, { sinr5: 2.7 }, -1.3, { c: -1.8, r2: -0.5, sinr1: -1.8 }],
    ].map(([count, x0, x1, y0, y1]) =>
        group(
            count,
            pt('mote', color, 0.419, 0.581, {
                x: [x0, x1, 'outCubic'],
                y: [y0, y1, 'outCubic'],
                w: { r3: 0.09 },
                a: [1, 0, 'inOutElastic'],
            }),
        ),
    )

// Critical flicks: a fan of needles opening along the flick.
const needleFan = (color) =>
    Array.from({ length: 10 }, (_, k) => {
        const r = 1.2 - (2.48 * k) / 9
        const [dx, dy] = [-Math.sin(r), Math.cos(r)]
        const near = 0.55 + 0.25 * spread(k, 1)
        const far = near + 1 + 0.6 * spread(k, 2)
        return pt('needle', k % 3 ? white : pale(color, 0.4), 0.522, 0.478, {
            x: [near * dx, far * dx, 'outCubic'],
            y: [-0.8 + near * dy, -0.8 + far * dy, 'outCubic'],
            w: [0.05, 0, 'outCubic'],
            h: [0.9 + 0.3 * spread(k, 3), 0, 'outCubic'],
            r: round(r),
            a: [0.7, 0],
        })
    })
// And sparkles flung out round the note.
const sparkleFan = (color) =>
    Array.from({ length: 18 }, (_, k) => {
        const angle = Math.PI * (-0.15 + 1.3 * ((k + 0.5) / 18)) + 0.2 * (spread(k, 1) - 0.5)
        const near = 0.3 + 0.9 * spread(k, 2)
        const far = 1.8 + 2.2 * spread(k, 3)
        const [c, s] = [Math.cos(angle), Math.sin(angle)]
        const size = 0.25 + 0.35 * spread(k, 4)
        return pt('sparkle', sparkleTints(color)[k % 4], 0.209, 0.791, {
            x: [near * c, far * c, 'outCubic'],
            y: [-1 + near * s, -1 + far * s * 0.9, 'outCubic'],
            w: [{ c: round(size), sinr1: 0.1 }, 0],
            a: [0.8, 0, 'inCubic'],
        })
    })

// Hits on the stage plane: the circular quad, 3.5 lanes wide and flat on the stage.

// A few shards flung off the hit on the stage.
const hitDust = (color, count, { alpha = 1, size: big = 0.12 } = {}) =>
    Array.from({ length: count }, (_, k) => {
        const angle = (2 * Math.PI * (k + 0.3 + 0.4 * spread(k, 1))) / count
        const [c, s] = [Math.cos(angle), Math.sin(angle)]
        const near = 0.3 * spread(k, 2)
        return pt('shard', color, 0, 0.697, {
            x: [near * c, { c: round(0.7 * c), r1: 0.3, r2: -0.3 }, 'outCubic'],
            y: [near * s, { c: round(0.75 * s), r1: -0.3, r2: 0.3 }, 'outCubic'],
            w: { c: round(big - 0.04 * spread(k, 3)), sinr5: -0.04 },
            a: [alpha, 0],
        })
    })
// The white-hot start: a small bright oval on the note with a glint, shrinking as it fades.
const hotStart = (color) => [
    pt('glow', color, 0, 0.636, {
        y: [-0.09, 0],
        w: [0.6, 0.15],
        h: [0.75, 0.2],
        a: [1, 0.1, 'outQuad'],
    }),
    pt('flare', white, 0, 0.4, { w: [0.5, 0.1], h: [0.6, 0.12], a: [1, 0, 'outQuad'] }),
]

// Slide starts and ends (and critical ones in their colour).
const slideHit = (color) => [
    once(
        pt('halo', color, 0, 0.558, {
            y: -0.09,
            w: [0, 1.25, 'outCubic'],
            h: [0, 1.5, 'outCubic'],
            a: [0.8, 0],
        }),
        pt('frame', pale(color, 0.4), 0.084, 0.474, {
            y: [0, 0.3, 'outCubic'],
            w: [0, 1, 'outCubic'],
            h: [0, 1.13, 'outCubic'],
            a: [1, 0, 'inCubic'],
        }),
        pt('frame', pale(color, 0.4), 0.251, 0.307, {
            y: [-0.05, -0.16, 'outQuad'],
            w: [0.16, 0.67, 'outQuad'],
            h: [0.2, 0.84, 'outQuad'],
            a: [1, 0],
        }),
        ...[-1, 1].map((side) =>
            pt('line', pale(color, 0.4), 0, 0.668, {
                x: 0.8 * side,
                y: 0.3 * side,
                w: [0.1, 0.35, 'outCubic'],
                h: [0.13, 0.44, 'outCubic'],
                a: [1, 0, 'inCubic'],
            }),
        ),
        pt('frame', pale(color, 0.4), 0.028, 0.53, {
            y: [0, -0.18, 'outCubic'],
            w: [0, 0.75, 'outCubic'],
            h: [0, 0.94, 'outCubic'],
            a: [0.8, 0],
        }),
        pt('plate', pale(color, 0.4), 0.028, 0.53, {
            y: [0, -0.09, 'outCubic'],
            w: [0, 0.4, 'outCubic'],
            h: [0, 0.5, 'outCubic'],
            a: [0.9, 0, 'inQuad'],
        }),
        pt('plate', white, 0.028, 0.53, {
            y: [0, -0.09, 'outCubic'],
            w: [0, 0.4, 'outCubic'],
            h: [0, 0.5, 'outCubic'],
            a: [1, 0, 'outCubic'],
        }),
        pt('glow', white, 0, 0.558, {
            y: -0.09,
            w: [0, 1.25, 'outCubic'],
            h: [0, 1.5, 'outCubic'],
            a: [0.3, 0],
        }),
    ),
    once(...hotStart(pale(color, 0.5))),
]

// Frames turning in on a critical hit, then opening as they fade.
const turningFrames = (color, start) => [
    pt('frame', white, start, 0.223, {
        y: [0, 0.3, 'outCubic'],
        w: [0, 0.8, 'outCubic'],
        h: [0, 0.9, 'outCubic'],
        r: [-1.57, 0.04],
        a: 0.6,
    }),
    pt('frame', white, start + 0.223, 0.279, {
        y: 0.3,
        w: [0.8, 1, 'outCubic'],
        h: [0.9, 1.13, 'outCubic'],
        r: 0.04,
        a: [0.55, 0, 'inCubic'],
    }),
    pt('frame', color, start, 0.223, {
        y: [0, 0.3, 'outCubic'],
        w: [0, 0.8, 'outCubic'],
        h: [0, 0.9, 'outCubic'],
        r: [-1.57, 0.04],
        a: [1, 0, 'outQuad'],
    }),
]

// Traces at the note, in the tick quad (eight lanes across): kept lighter than the base's, as
// the owner asked (scale).
const traceScale = 0.45

// Held slides loop over 1 s. A particle that runs past the end continues from the start; with
// linear properties the two halves join exactly.
const wrapped = (particle) => {
    const end = particle.start + particle.duration
    if (end <= 1) return [particle]
    const cut = (1 - particle.start) / particle.duration
    const at = (property) => {
        const mixed = {}
        for (const key of new Set([...Object.keys(property.from), ...Object.keys(property.to)]))
            mixed[key] = round(
                (property.from[key] ?? 0) +
                    ((property.to[key] ?? 0) - (property.from[key] ?? 0)) * cut,
            )
        return mixed
    }
    const split = (from, to, start, duration) => {
        const out = { ...particle, start: round(start), duration: round(duration) }
        for (const key of ['x', 'y', 'w', 'h', 'r', 'a'])
            out[key] = { from: from(particle[key]), to: to(particle[key]), ease: 'linear' }
        return out
    }
    return [
        split((p) => p.from, at, particle.start, 1 - particle.start),
        split(at, (p) => p.to, 0, end - 1),
    ]
}

/** The groups of each kind of effect for one colour. */
export const kinds = {
    none: () => [],

    // Above the note. Taps: shards and fine dust rising off the line.
    tapLinear: (color) => [group(7, shards(pale(color, 0.5))), group(18, dust(white))],
    // Slides: a soft column, glints and a few shards.
    slideLinear: (color) => [
        once(column(color, { start: 0.1, duration: 0.7, y: 1, w: 0.8, h: 3.75, alpha: 0.3 })),
        group(
            10,
            pt('flare', pale(color, 0.4), 0.033, 0.6, {
                x: { sinr6: 0.9 },
                y: [{ c: -0.3, sinr1: 1.2 }, { c: 1, sinr1: 1.8 }, 'outCubic'],
                w: 0.1,
                a: [0.75, 0],
            }),
        ),
        group(
            6,
            pt('shard', pale(color, 0.5), 0.033, 0.6, {
                x: [{ sinr5: 0.3 }, { sinr5: 1.3 }, 'outCubic'],
                y: [{ c: -0.6, sinr2: 0.3 }, { c: 1, sinr2: 0.7 }, 'outCubic'],
                w: { r3: 0.05 },
                h: [{ c: 0.1, r4: 0.2 }, { r3: 0.1 }],
                a: [0.75, 0],
            }),
        ),
    ],
    // Flicks: a fan of light opening upwards, shards thrown out all round, and dust.
    flickLinear: (color) => [
        once(
            pt('fan', pale(color, 0.45), 0.1, 0.73, {
                y: [-0.6, 0, 'outExpo'],
                w: [0, 2.5, 'outExpo'],
                h: [0, 1.5, 'outExpo'],
                a: [0.9, 0, 'outQuad'],
            }),
        ),
        once(...burst(pale(color, 0.55), 19)),
        group(18, dust(white, { alpha: 1, fade: 'outCubic' })),
    ],
    // Every critical: shards and wide arcs of light rising, a soft column, sparkles.
    criticalLinear: (color) => [
        group(
            8,
            shards(pale(color, 0.5)),
            arc(pale(color, 0.3), { duration: 0.5, ease: 'outExpo', alpha: 0.15, fade: 'outQuad' }),
        ),
        group(
            2,
            column(color, {
                start: 0.033,
                duration: 0.5,
                w: 0.95,
                h: 2.3,
                alpha: 0.5,
                fade: 'outCubic',
            }),
        ),
        group(
            3,
            arc(pale(color, 0.15), { duration: 0.2, ease: 'outQuad', alpha: 1, fade: 'outQuart' }),
        ),
        group(
            5,
            pt('sparkle', pale(color, 0.3), 0.033, 0.6, {
                x: { sinr6: 0.65 },
                y: [{ c: 0.4, sinr2: 1.5 }, { c: 1, sinr2: 2 }, 'outCubic'],
                w: 0.12,
                a: [0.9, 0],
            }),
        ),
        group(2, ...sparkleBurst(color)),
    ],

    // Flicks, in the linear square turned to the flick (y runs along the flick, 0.32 s).
    directional: (color) => [...flickers(pale(color, 0.45)), once(...flame(color))],
    criticalDirectional: (color) => [
        once(...sparkleFan(color)),
        ...flickers(pale(color, 0.5)),
        once(...needleFan(color), ...flame(color)),
    ],

    // Hits on the stage. Taps: a halo opening, frames and plates on the note, side glints, dust
    // and a white-hot start.
    tapCircular: (color) => [
        once(
            pt('halo', color, 0.084, 0.558, {
                y: -0.2,
                w: [0, 1.32, 'outCubic'],
                h: [0, 1.65, 'outCubic'],
                a: [0.9, 0],
            }),
            ...[
                [0.084, 1],
                [0.195, 0.9],
            ].flatMap(([start, alpha]) => [
                pt('frame', pale(color, 0.5), start, 0.474, {
                    y: [-0.2, 0.17, 'outCubic'],
                    w: 0.62,
                    h: 0.74,
                    a: [alpha, 0],
                }),
                pt('line', white, start, 0.474, {
                    y: [-0.2, 0.17, 'outCubic'],
                    w: 0.62,
                    h: 0.74,
                    a: [1, 0, 'outQuart'],
                }),
            ]),
            ...[-1, 1].map((side) =>
                pt('line', white, 0.167, 0.534, {
                    x: 0.6 * side,
                    y: { [side < 0 ? 'sinr1' : 'sinr2']: 0.3 },
                    w: [0.1, 0.3, 'outCubic'],
                    h: [0.1, 0.38, 'outCubic'],
                    a: [1, 0, 'inSine'],
                }),
            ),
            pt('frame', pale(color, 0.3), 0.195, 0.53, {
                y: [0, -0.2, 'outSine'],
                w: [0, 0.75, 'outSine'],
                h: [0, 0.94, 'outSine'],
                a: [1, 0],
            }),
            pt('frame', pale(color, 0.3), 0.084, 0.586, {
                y: [0, -0.2, 'outCubic'],
                w: [0, 0.75, 'outCubic'],
                h: [0, 0.94, 'outCubic'],
                a: [1, 0, 'outQuad'],
            }),
            pt('frame', color, 0.084, 0.167, {
                y: [0, -0.134],
                w: [0, 0.5],
                h: [0, 0.63],
                a: [1, 0, 'outCubic'],
            }),
            pt('plate', pale(color, 0.4), 0.056, 0.502, {
                y: [-0.02, -0.09, 'outQuad'],
                w: [0.1, 0.36, 'outQuad'],
                h: [0.13, 0.45, 'outQuad'],
                a: [0.6, 0, 'inQuad'],
            }),
            pt('plate', white, 0.056, 0.502, {
                y: [-0.02, -0.09, 'outQuad'],
                w: [0.1, 0.36, 'outQuad'],
                h: [0.13, 0.45, 'outQuad'],
                a: [1, 0, 'outQuint'],
            }),
        ),
        once(...hitDust(white, 4)),
        once(...hotStart(white)),
    ],
    slideCircular: slideHit,
    criticalSlideCircular: slideHit,
    // Flicks: a halo, frames opening fast, bright plates on the note.
    flickCircular: (color) => [
        once(
            pt('halo', color, 0, 0.558, {
                y: -0.22,
                w: [0, 1.5, 'outCubic'],
                h: [0, 1.7, 'outCubic'],
                a: [0.8, 0],
            }),
            pt('frame', pale(color, 0.5), 0, 0.558, {
                y: [0, -0.25, 'outExpo'],
                w: [0, 0.95, 'outExpo'],
                h: [0, 1.2, 'outExpo'],
                a: [0.8, 0, 'inQuad'],
            }),
            pt('frame', pale(color, 0.5), 0.112, 0.586, {
                y: [0, -0.25, 'outCubic'],
                w: [0, 0.95, 'outCubic'],
                h: [0, 1.2, 'outCubic'],
                a: [1, 0, 'inQuad'],
            }),
            pt('line', white, 0.112, 0.586, {
                y: [0, -0.25, 'outCubic'],
                w: [0, 0.7, 'outCubic'],
                h: [0, 1.2, 'outCubic'],
                a: [1, 0, 'outExpo'],
            }),
            pt('plate', pale(color, 0.4), 0.028, 0.641, {
                y: [0, -0.13, 'outExpo'],
                w: [0, 0.4, 'outExpo'],
                h: [0, 0.5, 'outExpo'],
                a: [0.6, 0],
            }),
            pt('plate', pale(color, 0.4), 0, 0.446, {
                y: [0, 0.072, 'outQuint'],
                w: [0, 0.65, 'outExpo'],
                h: [0, 0.73, 'outExpo'],
                a: [0.75, 0, 'inQuad'],
            }),
            pt('plate', white, 0, 0.446, {
                y: [0, 0.087, 'outQuint'],
                w: [0, 0.65, 'outExpo'],
                h: [0, 0.73, 'outExpo'],
                a: [1, 0, 'outCubic'],
            }),
            ...[0.1, 0.15].map((y) =>
                pt('plate', white, 0.223, 0.335, {
                    y: [y, 0.2, 'outExpo'],
                    w: [0.2, 0.4, 'outExpo'],
                    h: [0.23, 0.45, 'outExpo'],
                    a: [1, 0, 'outCubic'],
                }),
            ),
        ),
    ],
    // Criticals: a wide halo, frames turning in, big frames opening, bright plates and dust.
    criticalCircular: (color) => [
        once(
            pt('halo', pale(color, 0.15), 0.084, 0.641, {
                y: [0, -0.25, 'outCubic'],
                w: [0, 1.75, 'outCubic'],
                h: [0, 2.25, 'outCubic'],
                a: [0.8, 0, 'outQuad'],
            }),
            ...turningFrames(color, 0),
            ...turningFrames(color, 0.195),
            ...[-1, 1].map((side) =>
                pt('line', white, side < 0 ? 0.167 : 0.125, side < 0 ? 0.534 : 0.501, {
                    x: 0.9 * side,
                    y: { [side < 0 ? 'sinr2' : 'sinr1']: 0.4 },
                    w: [0.1, 0.45, 'outCubic'],
                    h: [0.13, 0.57, 'outCubic'],
                    a: [1, 0, side < 0 ? 'outQuad' : 'inCubic'],
                }),
            ),
            pt('frame', pale(color, 0.6), 0.028, 0.669, {
                y: [0, -0.28, 'outExpo'],
                w: [0, 1.166, 'outExpo'],
                h: [0, 1.458, 'outExpo'],
                a: [1, 0],
            }),
            pt('frame', pale(color, 0.4), 0.112, 0.586, {
                y: [-0.03, -0.28, 'outCubic'],
                w: [0.1, 1.1, 'outCubic'],
                h: [0.12, 1.38, 'outCubic'],
                a: [1, 0],
            }),
            pt('frame', pale(color, 0.4), 0.195, 0.641, {
                y: [-0.06, -0.28, 'outQuad'],
                w: [0.25, 1.1, 'outQuad'],
                h: [0.31, 1.38, 'outQuad'],
                a: [0.8, 0, 'inQuad'],
            }),
            ...[
                [color, 0.8, 'linear'],
                [white, 1, 'outQuart'],
                [pale(color, 0.5), 1, 'outExpo'],
            ].map(([tint, alpha, fade]) =>
                pt('plate', tint, 0.028, 0.697, {
                    y: [0, -0.2, 'outQuad'],
                    w: [0, 0.7, 'outQuad'],
                    h: [0, 0.88, 'outQuad'],
                    a: [alpha, 0, fade],
                }),
            ),
        ),
        once(...hitDust(white, 6, { alpha: 0.6, size: 0.12 })),
    ],
    // Critical flicks: two halos opening late, a frame bursting open, plates, and frames turning
    // in above the note twice.
    criticalFlickCircular: (color) => [
        once(
            ...[
                [0.167, 0.417, 0.6],
                [0.39, 0.445, 0.8],
            ].map(([start, duration, alpha]) =>
                pt('halo', pale(color, 0.3), start, duration, {
                    w: [0, 1.8, 'outCirc'],
                    h: [0, 2.52, 'outCirc'],
                    a: [alpha, 0],
                }),
            ),
        ),
        once(
            pt('frame', pale(color, 0.5), 0, 0.724, {
                y: -0.135,
                w: [0.33, 1.15, 'outExpo'],
                h: [0.462, 1.61, 'outExpo'],
                a: [1, 0, 'outQuad'],
            }),
            pt('frame', pale(color, 0.5), 0, 0.417, {
                y: -0.135,
                w: [0.33, 1.15, 'outQuart'],
                h: [0.462, 1.61, 'outQuart'],
                a: [0.75, 0, 'outQuad'],
            }),
            ...[
                [pale(color, 0.3), 'linear'],
                [white, 'outQuint'],
            ].map(([tint, fade]) =>
                pt('plate', tint, 0.028, 0.724, {
                    w: [0, 0.425, 'outExpo'],
                    h: [0, 0.6, 'outExpo'],
                    a: [0.8, 0, fade],
                }),
            ),
        ),
        ...[
            [0.028, 0.473],
            [0.278, 0.445],
        ].map(([start, duration]) =>
            once(
                ...[color, white].map((tint) =>
                    pt('frame', tint, start, duration, {
                        y: 0.65,
                        w: [0, 0.9, 'outExpo'],
                        h: [0, 1, 'outExpo'],
                        r: [-1.57, 0.04, 'outQuint'],
                        a: [1, 0],
                    }),
                ),
            ),
        ),
    ],

    // The lane column (the lane quad, 1 s): a short flash that shrinks away up the lane.
    lane: () => [
        once(
            pt('flash', white, 0, 0.1, { a: 0.3 }),
            pt('flash', white, 0.1, 0.1, { y: [0, 0.9, 'outSine'], h: [1, 0], a: [0.3, 0] }),
        ),
    ],
    // Criticals: a short coloured flash.
    criticalLane: (color) => [once(pt('flash', color, 0, 0.2, { a: [0.25, 0] }))],
    // Critical flicks (and critical trace flicks, which share it). The engine plays it over the
    // lane from the judge line up (not below it) for 1 s: a gold flash, then a bright streak
    // shooting up the lane to its far end, its white head leading, the base set's convention.
    criticalFlickLane: (color) => [
        once(
            pt('flash', color, 0, 0.06, { a: [0.3, 0.12] }),
            pt('flash', color, 0.06, 0.14, { a: [0.12, 0, 'outQuad'] }),
            ...[
                [color, 1, 0.2, 0.6],
                [white, 0.5, 0.16, 0.85],
            ].map(([tint, width, height, alpha]) =>
                pt('streak', tint, 0.05, 0.55, {
                    y: [-0.8, 0.88, 'outSine'],
                    w: width,
                    h: [height, height * 0.35],
                    a: [alpha, 0],
                }),
            ),
        ),
    ],
    // The standard lane effect (0.6 of its 1 s).
    laneBasic: () => [once(pt('flash', white, 0, 0.6, { a: [0.6, 0] }))],

    // Traces at the note: dust, a soft glow, a thin ring opening wide and a glint.
    traceTick: (color) => [
        group(
            5,
            pt('shard', pale(color, 0.5), 0, 0.668, {
                x: [0, { cosr2: 0.3 }, 'outCubic'],
                y: [0, { cosr3: 0.3 }, 'outCubic'],
                w: { r1: 0.075 },
                a: [0.7, 0, 'inCubic'],
            }),
        ),
        once(
            pt('glow', color, 0, 0.585, {
                w: [0, 1, 'outCubic'],
                a: [0.7 * traceScale, 0],
            }),
            pt('glow', white, 0, 0.585, {
                w: [0, 0.6, 'outCubic'],
                a: [0.7 * traceScale, 0, 'outQuart'],
            }),
            pt('ring', pale(color, 0.3), 0.084, 0.551, {
                w: [0, 0.625, 'outExpo'],
                a: [traceScale, 0, 'outQuad'],
            }),
            pt('flare', color, 0, 0.751, { w: 0.3, a: [0.8, 0, 'outCubic'] }),
            pt('flare', white, 0, 0.167, { w: 0.3, a: [1, 0, 'inCubic'] }),
        ),
    ],
    // Above it: two rings of confetti thrown out round the line, a soft column, glints rising and
    // glints settling low.
    traceLinear: (color) => [
        ...[
            [0.139, 'outQuint'],
            [0.028, 'outExpo'],
        ].map(([start, ease], wave) =>
            once(
                ...Array.from({ length: 15 }, (_, k) => {
                    const angle = Math.PI / 2 - (2 * Math.PI * (k + 0.25 * wave)) / 15
                    const [c, s] = [Math.cos(angle), Math.sin(angle)]
                    const randomSize = k < 8 ? `r${k + 1}` : `sinr${k - 7}`
                    return pt(
                        'shard',
                        [white, pale(color, 0.3), color][(k + wave) % 3],
                        start,
                        1 - start,
                        {
                            x: [0.3 * c, 3 * c, ease],
                            y: [-0.85 + 0.23 * s, -0.85 + 1.95 * s, ease],
                            w: { c: 0.15, [randomSize]: 0.05 },
                            a: [0.4 * traceScale * 2, 0, 'inOutElastic'],
                        },
                    )
                }),
            ),
        ),
        once(column(color, { duration: 0.5, y: 0.5, w: 1, h: 3.3, alpha: 0.3 * traceScale })),
        group(
            10,
            pt('flare', pale(color, 0.4), 0, 1, {
                x: [{ cosr1: 0.25 }, { cosr1: 0.5 }],
                y: [{ c: -1.3, sinr4: 0.3 }, { c: 1.3, r2: 2, sinr4: 1 }, 'outCubic'],
                w: 0.25,
                a: [1, 0, 'outCubic'],
            }),
        ),
        group(
            12,
            pt('flare', pale(color, 0.4), 0, 1, {
                x: [{ cosr1: 0.15 }, { cosr1: 1.5 }],
                y: [{ c: -1.3, sinr4: 0.3 }, { c: -0.5, r2: 0.4, sinr4: 0.6 }, 'outBack'],
                w: { c: 0.15, r2: -0.05 },
                a: [1, 0, 'outCubic'],
            }),
        ),
    ],
    // Slide ticks, the quietest hit: dust, a glint and a diamond frame opening.
    slideTick: (color) => [
        group(
            8,
            pt('shard', pale(color, 0.5), 0, 0.668, {
                x: [0, { cosr2: 0.6 }, 'outQuad'],
                y: [0, { cosr3: 0.6 }, 'outQuad'],
                w: { r1: 0.05 },
                a: [0.8, 0, 'inCubic'],
            }),
        ),
        once(
            pt('flare', pale(color, 0.4), 0, 0.585, { w: 0.3, a: [0.8, 0] }),
            pt('flare', white, 0, 0.167, { w: 0.3, a: [0.8, 0, 'inCubic'] }),
            pt('line', white, 0.112, 0.417, { w: [0, 0.61, 'outCubic'], a: [1, 0] }),
            pt('frame', pale(color, 0.4), 0.112, 0.417, { w: [0, 0.61, 'outCubic'], a: [0.8, 0] }),
        ),
    ],
    criticalSlideTick: (color) => [
        group(
            8,
            pt('shard', color, 0, 0.668, {
                x: [0, { cosr2: 0.6 }, 'outQuad'],
                y: [0, { cosr3: 0.6 }, 'outQuad'],
                w: { r1: 0.05 },
                a: [0.8, 0, 'inCubic'],
            }),
        ),
        once(
            pt('flare', pale(color, 0.4), 0, 0.585, { w: 0.3, a: [0.8, 0] }),
            pt('flare', white, 0, 0.167, { w: 0.3, a: [1, 0, 'inCubic'] }),
            pt('line', white, 0.134, 0.585, { w: [0, 0.71, 'outCubic'], a: [1, 0] }),
            pt('frame', pale(color, 0.4), 0.134, 0.585, { w: [0, 0.71, 'outCubic'], a: [0.8, 0] }),
        ),
    ],

    // Held slides (looped, 1 s, a quad twice the hit's): a glow fading each second, a plate
    // pulsing twice a second and a diamond frame turning under the finger.
    holdCircular: (color) => [
        once(
            pt('glow', color, 0, 1, { y: -0.1, w: 0.9, h: 1.2, a: [0.7, 0] }),
            ...[0, 0.5].map((start) =>
                pt('plate', pale(color, 0.4), start, 0.5, {
                    y: [-0.05, 0],
                    w: [0.3, 0.15],
                    h: [0.38, 0.19],
                    a: [1, 0.6, 'inQuad'],
                }),
            ),
            pt('line', white, 0, 1, { y: 0.1, w: 0.55, r: [0, -2 * Math.PI], a: 1 }),
            pt('glow', white, 0, 1, { y: -0.1, w: 0.5, h: 0.8, a: [0.7, 0] }),
        ),
    ],
    criticalHoldCircular: (color) => [
        once(
            pt('glow', color, 0, 1, { y: -0.15, w: 1, h: 1.4, a: [0.7, 0] }),
            ...[0, 0.5].map((start) =>
                pt('plate', pale(color, 0.5), start, 0.5, {
                    y: [-0.05, 0],
                    w: [0.3, 0.15],
                    h: [0.38, 0.19],
                    a: [1, 0.6, 'inQuad'],
                }),
            ),
            pt('line', white, 0, 1, { y: 0.1, w: 0.33, r: [0, -2 * Math.PI], a: 0.8 }),
        ),
    ],
    // Above it: soft rays of light coming and going round the hold point, shards blinking, glints
    // drifting out.
    holdLinear: (color) => [
        once(
            ...Array.from({ length: 16 }, (_, k) => {
                // Rays round the hold point, bright at the inner end.
                const angle = 2 * Math.PI * ((k + 0.5 * spread(k, 1)) / 16)
                const length = 0.5 + 0.7 * spread(k, 5)
                const reach = 0.15 + 0.9 * length
                return wrapped(
                    pt(
                        'wisp',
                        k % 5 === 4 ? white : pale(color, 0.2 + 0.3 * spread(k, 2)),
                        (k * 0.37) % 1,
                        0.7 + 0.3 * spread(k, 3),
                        {
                            x: round(reach * Math.cos(angle)),
                            y: round(-1 + reach * Math.sin(angle)),
                            w: round(length),
                            h: round(0.1 + 0.5 * spread(k, 6)),
                            r: round(angle),
                            a: [round(0.5 + 0.3 * spread(k, 8)), 0],
                        },
                    ),
                )
            }).flat(),
        ),
        ...Array.from({ length: 10 }, (_, k) =>
            once(
                ...wrapped(
                    pt('shard', white, k * 0.1, 0.6, {
                        x: { c: round(-1.2 + 2.6 * spread(k, 9)), r1: -0.25 },
                        y: { c: round(-1.9 + 1.6 * spread(k, 10)), r1: -0.2 },
                        w: { c: 0.1 + 0.1 * spread(k, 11), r1: 0.05 },
                        a: [{ c: 0.8, r1: -0.2, r2: -0.4 }, 0],
                    }),
                ),
            ),
        ),
        group(
            3,
            ...[
                ['cosr1', 'r2', 'sinr1', 0, 1],
                ['cosr2', 'r3', 'sinr2', 0.5, 0.5],
            ].map(([angle, lift, wobble, start, duration]) =>
                pt('flare', pale(color, 0.4), start, duration, {
                    x: [
                        { [angle]: start ? -0.4 : 0.4 },
                        { [angle]: start ? -2.3 : 2.3 },
                        'outCubic',
                    ],
                    y: [
                        { c: -1.3, [wobble]: 0.3 },
                        { c: -0.3, [lift]: 0.6, [wobble]: 0.3 },
                        'outCubic',
                    ],
                    w: 0.25,
                    a: [1, 0, 'outCubic'],
                }),
            ),
        ),
    ],
    // Trails behind a moving slide: a shard and three glints rising.
    trail: (color) => [
        once(
            pt('shard', pale(color, 0.5), 0, 1, {
                x: { cosr1: 0.4 },
                y: [{ c: -1.3, sinr1: 0.3 }, { c: 2.6, r2: 2, sinr1: 1.5 }, 'outCubic'],
                w: 0.15,
                a: [0.6, 0, 'inOutElastic'],
            }),
        ),
        group(
            3,
            pt('flare', pale(color, 0.4), 0, 1, {
                x: { cosr1: 0.4 },
                y: [{ c: -1.3, sinr1: 0.3 }, { c: 2.6, r2: 2, sinr1: 2 }, 'outCubic'],
                w: 0.25,
                a: [1, 0, 'outCubic'],
            }),
        ),
    ],
    // Slot motes over the held slide's lanes: two shards and a dot rising.
    holdSlot: (color) => [
        group(
            2,
            pt('shard', white, 0, 1, {
                x: { sinr5: 0.3 },
                y: [{ c: 0.8, sinr1: 1.8 }, { c: 1, sinr1: 2 }, 'outCubic'],
                w: 0.1,
                a: [0.75, 0, 'outCubic'],
            }),
        ),
        once(
            pt('mote', pale(color, 0.5), 0.033, 0.6, {
                x: { sinr5: 0.3 },
                y: [{ c: 0.4, sinr1: 1.8 }, { c: 1, sinr1: 2 }, 'outCubic'],
                w: 0.04,
                a: [0.9, 0],
            }),
        ),
    ],
}

const accents = {
    tap: baseColors.effect.tap,
    slide: bodyColors.slide[2],
    flick: baseColors.effect.flick,
    critical: bodyColors.critical[2],
    trace: baseColors.effect.trace,
    damage: damageColor,
    purple: styleColors('Purple')[2],
}

// Colours sampled from the base set are used as they are; the others are made vivid.
const sampled = new Set([
    ...Object.values(baseColors.effect),
    ...Object.values(baseColors.style).map((colors) => colors[5]),
])

/** A style colour's effect colour: the base set's slot glow colour for that style. */
const styleEffectColor = (name) => baseColors.style[name][5]

const plainColor = (name) => {
    if (name.includes('Damage')) return accents.damage
    if (name.includes('Critical')) return accents.critical
    if (name.includes('Flick')) return accents.flick
    if (name.includes('Trace')) return accents.trace
    if (name.includes('Slide')) return accents.slide
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
    ({
        Normal: 'tapCircular',
        Slide: 'slideCircular',
        Flick: 'flickCircular',
        'Down Flick': 'flickCircular',
        Critical: 'criticalCircular',
        'Critical Slide': 'criticalSlideCircular',
        'Critical Flick': 'criticalFlickCircular',
        'Critical Down Flick': 'criticalFlickCircular',
    })[family]
const linearOf = (family) =>
    family.startsWith('Critical')
        ? 'criticalLinear'
        : family.includes('Flick')
          ? 'flickLinear'
          : family === 'Slide'
            ? 'slideLinear'
            : 'tapLinear'
const laneOf = (family) =>
    family.includes('Flick')
        ? family.startsWith('Critical')
            ? 'criticalFlickLane'
            : 'none'
        : family.startsWith('Critical')
          ? 'criticalLane'
          : 'lane'

/** Every effect: { name, kind, color }, in a fixed order. */
export function particleEffects() {
    const effects = []
    const names = new Set()
    const add = (name, kind, color) => {
        if (names.has(name)) throw new Error(`Duplicate particle effect name: ${name}`)
        names.add(name)
        effects.push({ name, kind, color: sampled.has(color) ? color : vivid(color) })
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
    family('Sekai Critical Slide Tick Note', 'criticalSlideTick')
    family('Sekai Normal Trace Note Circular', 'traceTick', { plain: false })
    family('Sekai Normal Trace Note Linear', 'traceLinear', { plain: false })
    family('Sekai Critical Trace Note Circular', 'traceTick')
    family('Sekai Critical Trace Note Linear', 'traceLinear')
    add('Sekai Trace Note Circular', 'traceTick', accents.trace)
    add('Sekai Trace Note Circular Green', 'traceTick', accents.trace)
    add('Sekai Trace Note Circular Yellow', 'traceTick', accents.critical)
    add('Sekai Trace Note Linear', 'traceLinear', accents.trace)
    add('Sekai Trace Note Linear Green', 'traceLinear', accents.trace)
    add('Sekai Trace Note Linear Yellow', 'traceLinear', accents.critical)
    for (const name of ['Normal', 'Critical']) {
        family(
            `Sekai ${name} Slide Connector Circular`,
            name === 'Critical' ? 'criticalHoldCircular' : 'holdCircular',
        )
        family(`Sekai ${name} Slide Connector Linear`, 'holdLinear')
        family(`Sekai ${name} Slide Connector Trail Linear`, 'trail')
        family(`Sekai ${name} Slide Connector Slot Linear`, 'holdSlot')
        add(`Sekai ${name} Slide Trail Linear`, 'trail', plainColor(name))
    }

    // Older names the engine still declares.
    add('Sekai Critical Flick Circular Yellow', 'criticalFlickCircular', accents.critical)
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
                if (group === 'HOLD')
                    return linear
                        ? 'holdLinear'
                        : critical
                          ? 'criticalHoldCircular'
                          : 'holdCircular'
                if (group === 'ALTERNATIVE')
                    return linear
                        ? critical
                            ? 'criticalDirectional'
                            : 'directional'
                        : critical
                          ? 'criticalSlideTick'
                          : 'slideTick'
                if (critical) return linear ? 'criticalLinear' : 'criticalCircular'
                if (color === 'RED') return linear ? 'flickLinear' : 'flickCircular'
                if (color === 'GREEN') return linear ? 'slideLinear' : 'slideCircular'
                return linear ? 'tapLinear' : 'tapCircular'
            }
            if (!(group === 'ALTERNATIVE' && color === 'GREEN'))
                add(`#NOTE_LINEAR_${group}_${color}`, kindOf(true), standardColors[color])
            if (!(group === 'ALTERNATIVE' && color === 'RED'))
                add(`#NOTE_CIRCULAR_${group}_${color}`, kindOf(false), standardColors[color])
        }

    return effects
}
