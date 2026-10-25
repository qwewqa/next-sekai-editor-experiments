import assert from 'node:assert/strict'
import test from 'node:test'
import Type from 'typebox'
import Value from 'typebox/value'
import { noteStyleSchema } from '../../src/chart/noteStyle'
import { defaultNoteSlidePropertiesSchema } from '../../src/settings/defaultProperties'

// The preset schema is one object. It must read, repair and decode every stored value as the
// intersection it replaced does.

const { properties } = defaultNoteSlidePropertiesSchema
const rest = Object.fromEntries(
    Object.entries(properties).filter(([key]) => key !== 'copyProperties'),
) as Omit<typeof properties, 'copyProperties'>
const intersection = Type.Intersect([
    Type.Object(rest, { required: [] }),
    Type.Object({ copyProperties: Type.Boolean({ default: true }) }),
])

const lists = (item: Type.TSchema, count: number) =>
    Type.Array(item, { minItems: count, maxItems: count, default: [] })
const flat = lists(defaultNoteSlidePropertiesSchema, 4)
const old = lists(intersection, 4)

/** What a call gives, or the error it throws. */
const outcome = (run: () => unknown) => {
    try {
        return { value: run() }
    } catch (error) {
        return { error: (error as Error).constructor.name }
    }
}

const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const literalsOf = (schema: unknown): unknown[] => {
    const { anyOf, const: literal } = schema as { anyOf?: unknown[]; const?: unknown }
    return anyOf ? anyOf.flatMap(literalsOf) : literal === undefined ? [] : [literal]
}

const keys = Object.keys(rest)
const valid: Record<string, unknown[]> = Object.fromEntries(
    keys.map((key) => {
        const schema = rest[key as keyof typeof rest]
        const literals = literalsOf(schema)
        const type = (schema as { type?: string }).type
        return [key, literals.length ? literals : type === 'boolean' ? [true, false] : [0, 0.5, -3]]
    }),
)
// The ease and style unions are literal lists; the others take their own type.
assert.ok(literalsOf(noteStyleSchema).length > 3)
const damaged = ['x', '', 0, -1, NaN, null, undefined, true, [], {}, ['up'], { a: 1 }]

const sampleList = (next: () => number) => {
    const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)] as T
    // Half the lists are whole; the rest carry some damage.
    const whole = next() < 0.5
    return Array.from({ length: 4 }, () => {
        if (!whole && next() < 0.03) return pick(damaged)
        const preset: Record<string, unknown> = {}
        for (const key of keys) if (next() < 0.25) preset[key] = pick(valid[key] as unknown[])
        if (whole || next() < 0.9)
            preset.copyProperties = !whole && next() < 0.2 ? pick(damaged) : pick([true, false])
        if (next() < 0.1) preset[pick(['connectorGuideColor', 'extra', 'copy'])] = pick(damaged)
        if (!whole) for (const key of keys) if (next() < 0.04) preset[key] = pick(damaged)
        return preset
    })
}

test('the preset object checks, repairs and decodes as the intersection did', () => {
    const next = random(11)
    const defaults = [
        { copyProperties: true },
        { isCritical: true, copyProperties: true },
        { flickDirection: 'up', copyProperties: true },
        { noteType: 'trace', copyProperties: true },
    ]
    const stored: unknown[] = [
        defaults,
        [],
        [{}, {}, {}, {}],
        [...defaults, { copyProperties: true }],
        undefined,
        null,
        'x',
        [null, 1, 'a', []],
        defaults.map((preset) => ({ ...preset, connectorGuideColor: 'red', future: 1 })),
        ...Array.from({ length: 120 }, () => sampleList(next)),
    ]

    let accepted = 0
    for (const value of stored) {
        const description = JSON.stringify(value)
        assert.equal(Value.Check(flat, value), Value.Check(old, value), description)
        assert.deepEqual(
            outcome(() => Value.Repair(flat, structuredClone(value))),
            outcome(() => Value.Repair(old, structuredClone(value))),
            description,
        )
        const now = outcome(() => Value.Decode(flat, Value.Repair(flat, structuredClone(value))))
        assert.deepEqual(
            now,
            outcome(() => Value.Decode(old, Value.Repair(old, structuredClone(value)))),
            description,
        )
        if ('value' in now && Value.Check(flat, value)) accepted++
    }
    assert.ok(accepted > 30, `${accepted} valid lists`)
})
