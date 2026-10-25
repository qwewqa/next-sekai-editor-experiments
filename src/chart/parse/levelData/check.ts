import type Type from 'typebox'
import Guard from 'typebox/guard'
import Value from 'typebox/value'

type Check = (value: unknown) => boolean

const checks = new WeakMap<object, Check>()

// Keywords the compiled checks cover; a schema with any other key goes through `Value.Check`.
const handled = new Set([
    'type',
    'const',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'anyOf',
    'default',
    'properties',
    'required',
    'items',
])

// Own keys, enumerable or not (typebox keeps `~refine` and others hidden). `~kind` and
// `~optional` tag a schema and are not read by the check.
const keysOf = (schema: object) =>
    Reflect.ownKeys(schema).filter((key) => key !== '~kind' && key !== '~optional')

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const typeChecks: Record<string, Check> = {
    number: Number.isFinite,
    integer: Number.isInteger,
    string: (value) => typeof value === 'string',
    boolean: (value) => typeof value === 'boolean',
    null: (value) => value === null,
    array: Array.isArray,
    object: isObject,
}

// As typebox reads a key: prototype keys are not counted for the three unsafe names.
const has = (value: object, key: string) =>
    key === '__proto__' || key === 'constructor' || key === 'prototype'
        ? Object.hasOwn(value, key)
        : key in value

const compile = (schema: unknown): Check => {
    const slow = (value: unknown) => Value.Check(schema as Type.TSchema, value)
    if (!isObject(schema) || keysOf(schema).some((key) => !handled.has(key as string))) return slow

    const { type, const: literal, anyOf, properties, required, items } = schema
    const parts: Check[] = []

    const typeCheck = typeof type === 'string' ? typeChecks[type] : undefined
    if (type !== undefined) {
        if (!typeCheck) return slow
        parts.push(typeCheck)
    }

    if (literal !== undefined) {
        if (typeof literal === 'object' || typeof literal === 'function') return slow
        parts.push((value) => value === literal)
    }

    const limits = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']
    if (limits.some((key) => key in schema)) {
        // The limits apply to numbers; the type already says the value is one.
        if (type !== 'number' && type !== 'integer') return slow
        const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf } = schema
        const set = (limit: unknown): limit is number => limit !== undefined
        parts.push(
            (value) =>
                (!set(minimum) || (value as number) >= minimum) &&
                (!set(maximum) || (value as number) <= maximum) &&
                (!set(exclusiveMinimum) || (value as number) > exclusiveMinimum) &&
                (!set(exclusiveMaximum) || (value as number) < exclusiveMaximum) &&
                (!set(multipleOf) || Guard.IsMultipleOf(value as number, multipleOf)),
        )
    }

    if (properties !== undefined || required !== undefined) {
        const names = Array.isArray(required) ? (required as unknown[]) : []
        if (
            type !== 'object' ||
            (required !== undefined && !names.every((name) => typeof name === 'string')) ||
            (properties !== undefined && !isObject(properties))
        )
            return slow

        const keys = names as string[]
        const fields = Object.entries(properties ?? {}).map(
            ([key, field]) => [key, compile(field), keys.includes(key)] as const,
        )
        parts.push((value) => {
            const object = value as Record<string, unknown>
            for (const key of keys) if (!has(object, key)) return false
            // An optional key may be absent or undefined.
            for (const [key, check, isRequired] of fields) {
                if (!has(object, key)) continue
                if (!isRequired && object[key] === undefined) continue
                if (!check(object[key])) return false
            }
            return true
        })
    }

    if (items !== undefined) {
        if (type !== 'array' || !isObject(items)) return slow
        const check = compile(items)
        parts.push((value) => {
            for (const item of value as unknown[]) if (!check(item)) return false
            return true
        })
    }

    if (anyOf !== undefined) {
        if (!Array.isArray(anyOf) || !anyOf.every(isObject)) return slow

        // A choice of numbers: a set answers it.
        const consts = anyOf.map((option) =>
            keysOf(option).length === 2 && option.type === 'number' ? option.const : undefined,
        )
        if (consts.every((literal) => typeof literal === 'number' && Number.isFinite(literal))) {
            const set = new Set(consts)
            parts.push((value) => typeof value === 'number' && set.has(value))
        } else {
            const options = anyOf.map(compile)
            parts.push((value) => {
                for (const check of options) if (check(value)) return true
                return false
            })
        }
    }

    // Every keyword applies, so an empty list accepts anything.
    const [only] = parts
    if (only && parts.length === 1) return only
    return (value) => {
        for (const part of parts) if (!part(value)) return false
        return true
    }
}

/** Whether the value is of the schema's type; each schema is compiled once, on first use. */
export const check = (schema: Type.TSchema, value: unknown) => {
    let compiled = checks.get(schema)
    if (!compiled) checks.set(schema, (compiled = compile(schema)))
    return compiled(value)
}

/**
 * Throws what `Value.Assert` throws when the value is not of the schema's type. The compiled
 * check answers a valid value; an invalid one is passed on for the error.
 */
export function assert<T extends Type.TSchema>(
    schema: T,
    value: unknown,
): asserts value is Type.Static<T> {
    if (!check(schema, value)) Value.Assert(schema, value)
}
