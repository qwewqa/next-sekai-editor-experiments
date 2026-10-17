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
])

// Own keys, enumerable or not (typebox keeps `~refine` and others hidden), without the `~kind` tag.
const keysOf = (schema: object) => Reflect.ownKeys(schema).filter((key) => key !== '~kind')

const compile = (schema: Type.TSchema): Check => {
    const keywords = schema as Record<string, unknown>
    if (keysOf(schema).some((key) => typeof key !== 'string' || !handled.has(key)))
        return (value) => Value.Check(schema, value)

    const { type, const: literal, minimum, maximum, anyOf, multipleOf } = keywords
    const { exclusiveMinimum, exclusiveMaximum } = keywords
    if (Array.isArray(anyOf)) {
        // A choice: numbers only, so a set answers it.
        const consts = (anyOf as Record<string, unknown>[]).map((option) =>
            keysOf(option).length === 2 && option.type === 'number' ? option.const : undefined,
        )
        if (consts.every((literal) => typeof literal === 'number')) {
            const set = new Set(consts)
            return (value) => typeof value === 'number' && set.has(value)
        }

        const options = (anyOf as Type.TSchema[]).map(compile)
        return (value) => options.some((check) => check(value))
    }

    if (type !== 'number' && type !== 'integer') return (value) => Value.Check(schema, value)
    const isInteger = type === 'integer'
    const has = (limit: unknown): limit is number => limit !== undefined
    return (value) =>
        (isInteger ? Number.isInteger(value) : Number.isFinite(value)) &&
        (literal === undefined || value === literal) &&
        (!has(minimum) || (value as number) >= minimum) &&
        (!has(maximum) || (value as number) <= maximum) &&
        (!has(exclusiveMinimum) || (value as number) > exclusiveMinimum) &&
        (!has(exclusiveMaximum) || (value as number) < exclusiveMaximum) &&
        (!has(multipleOf) || Guard.IsMultipleOf(value as number, multipleOf))
}

/** Whether the value is of the schema's type; each schema is compiled once, on first use. */
export const check = (schema: Type.TSchema, value: unknown) => {
    let compiled = checks.get(schema)
    if (!compiled) checks.set(schema, (compiled = compile(schema)))
    return compiled(value)
}
