import { domError, KeyRange, type Key, type KeyPath, type Query } from './types'

// IndexedDB's key rules for the in-memory store: validity, order and key paths.

const typeRank = (key: Key) =>
    typeof key === 'number'
        ? 0
        : key instanceof Date
          ? 1
          : typeof key === 'string'
            ? 2
            : Array.isArray(key)
              ? 4
              : 3

/** A copy of a valid key as IndexedDB stores it (binary as ArrayBuffer); undefined when invalid. */
export const normalizeKey = (key: unknown, seen = new Set<unknown>()): Key | undefined => {
    if (typeof key === 'number') return Number.isNaN(key) ? undefined : key
    if (typeof key === 'string') return key
    if (key instanceof Date) return Number.isNaN(key.getTime()) ? undefined : new Date(key)
    if (key instanceof ArrayBuffer) return key.slice(0)
    if (ArrayBuffer.isView(key))
        return new Uint8Array(key.buffer, key.byteOffset, key.byteLength).slice().buffer
    if (Array.isArray(key)) {
        if (seen.has(key)) return
        seen.add(key)
        const out: Key[] = []
        for (const item of key) {
            const normal = normalizeKey(item, seen)
            if (normal === undefined) return
            out.push(normal)
        }
        return out
    }
    return
}

export const requireKey = (key: unknown): Key => {
    const normal = normalizeKey(key)
    if (normal === undefined) throw domError('DataError', 'Not a valid key')
    return normal
}

const bytes = (key: ArrayBuffer | ArrayBufferView) =>
    key instanceof ArrayBuffer
        ? new Uint8Array(key)
        : new Uint8Array(key.buffer, key.byteOffset, key.byteLength)

/** IndexedDB's order: numbers, dates, strings, binary, arrays. */
export const compareKeys = (a: Key, b: Key): number => {
    const ra = typeRank(a)
    const rb = typeRank(b)
    if (ra !== rb) return ra < rb ? -1 : 1
    if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1
    if (a instanceof Date && b instanceof Date) {
        const ta = a.getTime()
        const tb = b.getTime()
        return ta === tb ? 0 : ta < tb ? -1 : 1
    }
    if (typeof a === 'string' && typeof b === 'string') {
        // Code units, as IndexedDB compares strings.
        return a === b ? 0 : a < b ? -1 : 1
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        for (let i = 0; i < Math.min(a.length, b.length); i++) {
            const c = compareKeys(a[i] ?? 0, b[i] ?? 0)
            if (c) return c
        }
        return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
    }
    const ba = bytes(a as ArrayBuffer)
    const bb = bytes(b as ArrayBuffer)
    for (let i = 0; i < Math.min(ba.length, bb.length); i++)
        if (ba[i] !== bb[i]) return (ba[i] ?? 0) < (bb[i] ?? 0) ? -1 : 1
    return ba.length === bb.length ? 0 : ba.length < bb.length ? -1 : 1
}

/** A query as a range of valid keys. */
export const toRange = (query: Query): KeyRange => {
    if (query instanceof KeyRange) {
        const lower = query.lower === undefined ? undefined : requireKey(query.lower)
        const upper = query.upper === undefined ? undefined : requireKey(query.upper)
        if (lower !== undefined && upper !== undefined) {
            const c = compareKeys(lower, upper)
            if (c > 0 || (c === 0 && (query.lowerOpen || query.upperOpen)))
                throw domError('DataError', 'An empty key range')
            return KeyRange.bound(lower, upper, query.lowerOpen, query.upperOpen)
        }
        if (lower !== undefined) return KeyRange.lowerBound(lower, query.lowerOpen)
        if (upper !== undefined) return KeyRange.upperBound(upper, query.upperOpen)
        throw domError('DataError', 'A key range needs a bound')
    }
    return KeyRange.only(requireKey(query))
}

export const inRange = (range: KeyRange, key: Key) => {
    if (range.lower !== undefined) {
        const c = compareKeys(key, range.lower)
        if (c < 0 || (c === 0 && range.lowerOpen)) return false
    }
    if (range.upper !== undefined) {
        const c = compareKeys(key, range.upper)
        if (c > 0 || (c === 0 && range.upperOpen)) return false
    }
    return true
}

const valueAt = (value: unknown, path: string): unknown => {
    if (path === '') return value
    let current = value
    for (const part of path.split('.')) {
        if (current === null || typeof current !== 'object') return
        current = (current as Record<string, unknown>)[part]
    }
    return current
}

/** The key at a key path; undefined when missing or not a valid key (the row is not indexed). */
export const keyAtPath = (value: unknown, keyPath: KeyPath): Key | undefined => {
    if (typeof keyPath === 'string') return normalizeKey(valueAt(value, keyPath))
    const parts: Key[] = []
    for (const path of keyPath) {
        const key = normalizeKey(valueAt(value, path))
        if (key === undefined) return
        parts.push(key)
    }
    return parts
}

/** Hex of a key, for test messages and maps keyed by binary keys. */
export const keyText = (key: Key): string => {
    if (Array.isArray(key)) return `[${key.map(keyText).join(',')}]`
    if (key instanceof Date) return `d${key.getTime()}`
    if (typeof key === 'number') return `n${key}`
    if (typeof key === 'string') return JSON.stringify(key)
    return `x${[...bytes(key)].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}
