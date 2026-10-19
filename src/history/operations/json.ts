export type JsonValue = null | boolean | number | string | JsonArray | JsonObject
export type JsonArray = readonly JsonValue[]
export type JsonObject = { readonly [key: string]: JsonValue }

export const OPERATION_WIRE_BYTES = 256 * 1024
export const OPERATION_WIRE_DEPTH = 16
export const OPERATION_NATIVE_BYTES = 64 * 1024

export class OperationDataError extends Error {}

const encoder = new TextEncoder()

export const jsonBytes = (value: JsonValue) => encoder.encode(JSON.stringify(value)).byteLength

const wellFormed = (text: string) => {
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i)
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = text.charCodeAt(++i)
            if (!(next >= 0xdc00 && next <= 0xdfff)) return false
        } else if (code >= 0xdc00 && code <= 0xdfff) return false
    }
    return true
}

export const isJsonText = (value: unknown): value is string =>
    typeof value === 'string' && wellFormed(value)

// Capture data without invoking getters, toJSON, or prototype setters.
export const captureJson = (
    input: unknown,
    { bytes = OPERATION_WIRE_BYTES, depth = OPERATION_WIRE_DEPTH } = {},
): JsonValue => {
    let size = 0
    const ancestors = new Set<object>()
    const add = (amount: number) => {
        size += amount
        if (size > bytes) throw new OperationDataError('Operation data exceeds its byte limit')
    }
    const text = (value: string) => {
        if (!wellFormed(value)) throw new OperationDataError('Operation text is not well formed')
        add(encoder.encode(JSON.stringify(value)).byteLength)
        return value
    }
    const visit = (value: unknown, level: number): JsonValue => {
        if (level > depth) throw new OperationDataError('Operation data exceeds its depth limit')
        if (value === null) {
            add(4)
            return null
        }
        if (typeof value === 'string') return text(value)
        if (typeof value === 'boolean') {
            add(value ? 4 : 5)
            return value
        }
        if (typeof value === 'number' && Number.isFinite(value)) {
            add(String(value).length)
            return value
        }
        if (typeof value !== 'object')
            throw new OperationDataError('Operation data must be finite JSON')
        if (ancestors.has(value)) throw new OperationDataError('Operation data is cyclic')
        const array = Array.isArray(value)
        const prototype: unknown = Object.getPrototypeOf(value)
        if (!array && prototype !== Object.prototype && prototype !== null)
            throw new OperationDataError('Operation data must use plain objects')
        ancestors.add(value)
        add(2)
        const properties = Object.getOwnPropertyDescriptors(value)
        if (Reflect.ownKeys(properties).some((key) => typeof key !== 'string'))
            throw new OperationDataError('Operation data has symbol keys')
        const keys = Object.keys(properties)
        let result: JsonValue
        if (array) {
            const length = value.length
            if (keys.length !== length + 1 || !properties.length)
                throw new OperationDataError('Operation arrays must be dense and unadorned')
            const items: JsonValue[] = []
            for (let i = 0; i < length; i++) {
                const property = properties[String(i)]
                if (!property || !property.enumerable || !('value' in property))
                    throw new OperationDataError('Operation arrays must contain data values')
                if (i) add(1)
                items.push(visit(property.value, level + 1))
            }
            result = Object.freeze(items)
        } else {
            const object: Record<string, JsonValue> = Object.create(null) as Record<
                string,
                JsonValue
            >
            for (const [i, key] of keys.entries()) {
                const property = properties[key]
                if (!property?.enumerable || !('value' in property))
                    throw new OperationDataError('Operation objects must contain enumerable data')
                if (i) add(1)
                text(key)
                add(1)
                object[key] = visit(property.value, level + 1)
            }
            result = Object.freeze(object)
        }
        ancestors.delete(value)
        return result
    }
    return visit(input, 0)
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

export const owns = (value: object, key: PropertyKey) =>
    Object.prototype.hasOwnProperty.call(value, key)

export const equalJson = (a: JsonValue, b: JsonValue): boolean => {
    if (a === b) return true
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b)) return false
        const left = a as JsonArray
        const right = b as JsonArray
        return (
            left.length === right.length &&
            left.every((value, i) => {
                const other = right[i]
                return other !== undefined && equalJson(value, other)
            })
        )
    }
    const left = a as JsonObject
    const right = b as JsonObject
    const keys = Object.keys(left)
    return (
        keys.length === Object.keys(right).length &&
        keys.every(
            (key) => owns(right, key) && equalJson(left[key] as JsonValue, right[key] as JsonValue),
        )
    )
}
