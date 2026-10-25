import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type Type from 'typebox'
import Value from 'typebox/value'
import { assert as assertSchema, check } from '../../src/chart/parse/levelData/check'
import { clipboardDataSchema } from '../../src/clipboard/data/schema'
import { autoSaveSchema } from '../../src/history/autoSave/schema'
import { levelDataEntitiesSchema } from '../../src/levelData/entities/schema'
import { levelDataSchema } from '../../src/levelData/schema'
import { readLevelData, samplePaths } from '../local/records/samples'
import { fullLevel } from './levelDataSynthetic'

// The compiled check stands in for `Value.Check` where level data is read, so it must answer the
// same on every value: the sample levels as they are, and many damaged copies of them.

// Third-party levels are never committed; NSE_LEVEL_DATA_DIRS adds folders (path-delimited).
const extraDirs = (process.env.NSE_LEVEL_DATA_DIRS ?? '').split(/[;:]/).filter(Boolean)
const folders = ['test_level_data', ...extraDirs].filter((dir) => existsSync(dir))
const files = [
    ...samplePaths,
    ...folders.flatMap((dir) =>
        readdirSync(dir, { recursive: true, encoding: 'utf8' })
            .filter((path) => /\.(json|gz)$/.test(path) && !path.endsWith('.bgm.mp3'))
            .map((path) => join(dir, path)),
    ),
]

const levels = () => {
    const found: { path: string; level: ReturnType<typeof readLevelData> }[] = []
    for (const path of new Set(files)) {
        try {
            const level = readLevelData(path)
            if (Array.isArray(level.entities)) found.push({ path, level })
        } catch {
            // Not level data.
        }
    }
    return found
}

// Seeded and bounded: the damage kinds and outcomes show up within the first few hundred damaged copies.
const DAMAGES_PER_DOCUMENT = 500
const ENTITIES_PER_LEVEL = 300

const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const wrongValues = (): unknown[] => [
    '',
    'x',
    '0',
    0,
    -1,
    0.5,
    1e308,
    -0,
    NaN,
    Infinity,
    -Infinity,
    null,
    undefined,
    true,
    false,
    [],
    [0],
    {},
    { name: 'a', value: 1 },
    { name: 'a', ref: 'b' },
    { name: 'a', value: 'b' },
    { name: 'a', ref: 1 },
    { archetype: 'a', data: [] },
    1n,
    Symbol('s'),
    () => 0,
]

const isNode = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null

/** Every object, array and value in a document, as the path that reaches it. */
const pathsOf = (root: unknown) => {
    const found: (string | number)[][] = []
    const walk = (value: unknown, path: (string | number)[]) => {
        found.push(path)
        if (!isNode(value)) return
        for (const key of Object.keys(value)) walk(value[key], [...path, key])
    }
    walk(root, [])
    return found
}

/** A copy of the document with one random damage, and what it was. */
const damage = (document: unknown, next: () => number) => {
    const copy = structuredClone(document)
    const paths = pathsOf(copy)
    const path = paths[Math.floor(next() * paths.length)] as (string | number)[]
    const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)] as T
    const kind = pick(['replace', 'replace', 'delete', 'extra', 'inherit', 'swap', 'length'])

    const parent = path.slice(0, -1).reduce<unknown>((value, key) => (value as never)[key], copy)
    const key = path[path.length - 1]
    const container = (path.length ? parent : { root: copy }) as Record<string | number, unknown>
    const slot = path.length ? (key as string | number) : 'root'
    const target = container[slot]
    let description = `${kind} ${path.join('/')}`

    const set = (value: unknown) => {
        container[slot] = value
        description += ` ${String(typeof value === 'symbol' ? 'symbol' : value)}`
    }
    if (kind === 'replace') set(pick(wrongValues()))
    else if (kind === 'delete' && path.length && !Array.isArray(container)) delete container[slot]
    else if (kind === 'delete' && path.length)
        (container as unknown as unknown[]).splice(Number(slot), 1)
    else if (kind === 'extra' && isNode(target))
        target[pick(['extra', 'name', 'ref', 'value'])] = pick(wrongValues())
    else if (kind === 'inherit' && isNode(target)) set(Object.create(target))
    else if (kind === 'swap' && Array.isArray(target)) set({ ...target })
    else if (kind === 'swap' && isNode(target)) set(Object.values(target))
    else if (kind === 'length' && Array.isArray(target)) target.push(pick(wrongValues()))
    else set(pick(wrongValues()))
    return { document: path.length ? copy : container.root, description }
}

const same = (schema: Type.TSchema, value: unknown, description: string) => {
    const expected = Value.Check(schema, value)
    assert.equal(check(schema, value), expected, description)
    return expected
}

const sampleEntities = (count: number) => fullLevel().slice(0, count)

const documents = (): [string, Type.TSchema, unknown][] => [
    [
        'level data',
        levelDataSchema,
        { bgmOffset: -0.25, entities: [...fullLevel(), ...sampleEntities(8)] },
    ],
    [
        'auto save',
        autoSaveSchema,
        { version: 1, filename: 'a', levelData: 'H4s', defaultGuideColors: [0, 3, 9] },
    ],
    ['auto save, level data', autoSaveSchema, { bgmOffset: 0, entities: sampleEntities(6) }],
    [
        'clipboard',
        clipboardDataSchema,
        {
            lane: 1.5,
            beat: 3,
            anchor: 2,
            defaultGuideColors: [1],
            source: { chart: 'c', groups: [0, 1], stages: [2] },
            entities: sampleEntities(6),
        },
    ],
]

test('the compiled check accepts and rejects what Value.Check does on the sample levels', () => {
    for (const [name, schema, document] of documents())
        assert.ok(same(schema, document, name), name)

    const found = levels()
    assert.ok(found.length > 0)
    for (const { path, level } of found) {
        assert.ok(same(levelDataSchema, level, path), path)
        // A level with one entity broken in turn at its start, middle and end.
        for (const index of [0, Math.floor(level.entities.length / 2), level.entities.length - 1]) {
            const broken = { ...level, entities: [...level.entities] }
            broken.entities[index] = { archetype: 1, data: [] } as never
            assert.equal(same(levelDataSchema, broken, `${path} ${index}`), false)
        }
    }
})

test('the compiled check answers as Value.Check does on many damaged documents', () => {
    const next = random(20241024)
    let accepted = 0
    let rejected = 0
    for (const [name, schema, document] of documents()) {
        for (let i = 0; i < DAMAGES_PER_DOCUMENT; i++) {
            const damaged = damage(document, next)
            const result = same(schema, damaged.document, `${name}: ${damaged.description}`)
            if (result) accepted++
            else rejected++
        }
    }
    assert.ok(accepted > 100 && rejected > 1000, `${accepted} accepted, ${rejected} rejected`)
})

test('the compiled check answers as Value.Check does on damaged entities of the sample levels', () => {
    const next = random(7)
    const entitySchema = levelDataEntitiesSchema.items
    let rejected = 0
    for (const { path, level } of levels()) {
        const stride = Math.max(1, Math.floor(level.entities.length / ENTITIES_PER_LEVEL))
        for (let i = 0; i < level.entities.length; i += stride) {
            const entity = level.entities[i]
            assert.ok(same(entitySchema, entity, `${path} ${i}`), `${path} ${i}`)
            for (let n = 0; n < 3; n++) {
                const damaged = damage(entity, next)
                if (!same(entitySchema, damaged.document, `${path} ${i}: ${damaged.description}`))
                    rejected++
            }
        }
    }
    assert.ok(rejected > 100)
})

test('assert passes a valid value and throws what Value.Assert throws for an invalid one', () => {
    const level = { bgmOffset: 0, entities: sampleEntities(5) }
    assertSchema(levelDataSchema, level)

    const broken = { bgmOffset: 0, entities: [{ archetype: 'a', data: [{ name: 'b' }] }] }
    let expected: unknown
    try {
        Value.Assert(levelDataSchema, broken)
    } catch (error) {
        expected = error
    }
    assert.throws(
        () => assertSchema(levelDataSchema, broken),
        (error: Error) =>
            error.constructor === (expected as Error).constructor &&
            error.message === (expected as Error).message,
    )
})
