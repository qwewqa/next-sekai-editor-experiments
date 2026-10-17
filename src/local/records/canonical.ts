/** A record's JSON form: arrays of strings, finite numbers and booleans (§1.6.11.1). */
export type RecordValue = string | number | boolean | readonly RecordValue[]

/** The canonical text of a record; throws on anything a record can't hold. */
export const canonical = (value: RecordValue): string => {
    if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new TypeError(`Unexpected number ${String(value)}`)
        return JSON.stringify(value)
    }
    // Plain arrays only: typed arrays, `toJSON` and objects would change a hash silently.
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
        throw new TypeError(`Unexpected ${describe(value)}`)
    let text = '['
    for (let i = 0; i < value.length; i++) {
        if (!(i in value)) throw new TypeError('Unexpected hole')
        if (i) text += ','
        text += canonical(value[i] as RecordValue)
    }
    return text + ']'
}

const describe = (value: unknown) =>
    value === null ? 'null' : typeof value === 'object' ? 'object' : typeof value

const encoder = new TextEncoder()

/** A record's canonical bytes: its canonical text as UTF-8. */
export const canonicalBytes = (value: RecordValue) => encoder.encode(canonical(value))
