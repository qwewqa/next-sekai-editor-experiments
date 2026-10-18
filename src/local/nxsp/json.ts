import { toWellFormed } from '../records/wellFormed'

// JSON in a `.nxsp` (§1.6.11's conventions): UTF-8 decoded strictly, one leading byte-order mark
// stripped, the last value of a duplicate key kept (as `JSON.parse` does), and nesting capped.

/** The deepest nesting a reader accepts (§1.6.11.4): deeper is damage. */
export const JSON_DEPTH_CAP = 64

/** JSON that cannot be read: invalid UTF-8, invalid JSON, or nesting past the cap. */
export class JsonError extends Error {
    override name = 'JsonError'
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Throws when arrays and objects nest deeper than `cap`; strings are skipped. */
export const checkDepth = (text: string, cap = JSON_DEPTH_CAP) => {
    let depth = 0
    let inString = false
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i)
        if (inString) {
            if (c === 0x5c) i++
            else if (c === 0x22) inString = false
        } else if (c === 0x22) inString = true
        else if (c === 0x5b || c === 0x7b) {
            if (++depth > cap) throw new JsonError(`Nested deeper than ${cap}`)
        } else if (c === 0x5d || c === 0x7d) depth--
    }
}

/** Parses a JSON entry's bytes strictly. */
export const parseJsonBytes = (bytes: Uint8Array, cap = JSON_DEPTH_CAP): unknown => {
    let text: string
    try {
        text = decoder.decode(bytes)
    } catch {
        throw new JsonError('Not UTF-8')
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    checkDepth(text, cap)
    try {
        return JSON.parse(text) as unknown
    } catch (error) {
        throw new JsonError(error instanceof Error ? error.message : 'Not JSON')
    }
}

/** A plain JSON object (not an array or null). */
export const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

/** Sets an own key, `__proto__` included (plain assignment would set the prototype instead). */
export const setKey = (target: Record<string, unknown>, key: string, value: unknown) => {
    Object.defineProperty(target, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
    })
}

/** A JSON value with every string, keys included, well-formed (§1.6.11's conventions). */
export const wellFormedJson = (value: unknown): unknown => {
    if (typeof value === 'string') return toWellFormed(value)
    if (Array.isArray(value)) return value.map(wellFormedJson)
    if (isObject(value))
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [toWellFormed(key), wellFormedJson(item)]),
        )
    return value
}

const encoder = new TextEncoder()

/** A JSON value's UTF-8 bytes, without whitespace or a byte-order mark. */
export const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value))
