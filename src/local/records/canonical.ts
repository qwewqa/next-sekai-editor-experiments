/** A record's JSON form: arrays of strings, finite numbers and booleans. */
export type RecordValue = string | number | boolean | readonly RecordValue[]

/**
 * Throws on anything a record can't hold: plain arrays without holes or `toJSON`, strings,
 * booleans and finite numbers only, so a bug can't change a hash silently.
 */
const checkValue = (value: unknown): void => {
    if (typeof value === 'string' || typeof value === 'boolean') return
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new TypeError(`Unexpected number ${String(value)}`)
        return
    }
    // Plain arrays only: typed arrays, `toJSON` and objects would change a hash silently.
    if (
        !Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Array.prototype ||
        (value as { toJSON?: unknown }).toJSON !== undefined
    )
        throw new TypeError(`Unexpected ${describe(value)}`)
    for (let i = 0; i < value.length; i++) {
        if (!(i in value)) throw new TypeError('Unexpected hole')
        checkValue(value[i])
    }
}

/**
 * The canonical text of a record; throws on anything a record can't hold. For a
 * checked value `JSON.stringify` writes exactly the canonical rule: each scalar as
 * `Number::toString` or `QuoteJSONString` gives it, items joined by commas, no whitespace.
 */
export const canonical = (value: RecordValue): string => {
    checkValue(value)
    return JSON.stringify(value)
}

const describe = (value: unknown) =>
    value === null ? 'null' : typeof value === 'object' ? 'object' : typeof value

const encoder = new TextEncoder()

/** A record's canonical bytes: its canonical text as UTF-8. */
export const canonicalBytes = (value: RecordValue) => encoder.encode(canonical(value))
