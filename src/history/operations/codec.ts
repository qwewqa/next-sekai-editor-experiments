import { isJsonText, isObject, owns } from './json'

export type Codec<T> = { readonly is: (value: unknown) => value is T }
export type ValueOf<C> = C extends Codec<infer T> ? T : never

export const codec = <T>(is: (value: unknown) => boolean): Codec<T> => ({
    is: is as (value: unknown) => value is T,
})

export const finite = codec<number>((value) => typeof value === 'number' && Number.isFinite(value))
export const count = codec<number>((value) => Number.isSafeInteger(value) && (value as number) >= 0)
export const positive = codec<number>((value) => count.is(value) && value > 0)
export const boolean = codec<boolean>((value) => typeof value === 'boolean')
export const text = codec<string>(isJsonText)
export const nil = codec<null>((value) => value === null)
export const literal = <const T extends string | number | boolean>(expected: T) =>
    codec<T>((value) => value === expected)
export const oneOf = <const T extends readonly string[]>(values: T) =>
    codec<T[number]>((value) => typeof value === 'string' && values.includes(value))
export const union = <const C extends readonly Codec<unknown>[]>(...codecs: C) =>
    codec<ValueOf<C[number]>>((value) => codecs.some((item) => item.is(value)))
export const list = <T>(item: Codec<T>, max: number, min = 0) =>
    codec<readonly T[]>(
        (value) =>
            Array.isArray(value) &&
            value.length >= min &&
            value.length <= max &&
            value.every(item.is),
    )

type Shape = Record<string, Codec<unknown>>
type ShapeValue<S extends Shape> = { readonly [K in keyof S]: ValueOf<S[K]> }

export const object = <const R extends Shape, const O extends Shape = Record<never, never>>(
    required: R,
    optional?: O,
) =>
    codec<ShapeValue<R> & Partial<ShapeValue<O>>>((value) => {
        if (!isObject(value)) return false
        const permitted = new Set([...Object.keys(required), ...Object.keys(optional ?? {})])
        return (
            Object.keys(value).every((key) => permitted.has(key)) &&
            Object.entries(required).every(
                ([key, item]) => owns(value, key) && item.is(value[key]),
            ) &&
            Object.entries(optional ?? {}).every(
                ([key, item]) => !owns(value, key) || item.is(value[key]),
            )
        )
    })

export const refine = <T>(base: Codec<T>, accepts: (value: T) => boolean): Codec<T> =>
    codec<T>((value) => base.is(value) && accepts(value))
