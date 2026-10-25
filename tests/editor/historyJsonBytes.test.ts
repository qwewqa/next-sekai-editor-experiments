import assert from 'node:assert/strict'
import test from 'node:test'
import {
    captureJson,
    jsonBytes,
    jsonStringBytes,
    utf8Length,
    type JsonValue,
} from '../../src/history/operations/json'

// The byte counts of the operation limits, counted without encoding, against TextEncoder: every
// count must be the encoder's, or a limit would move.

const encoder = new TextEncoder()
const encoded = (text: string) => encoder.encode(text).byteLength

const isWellFormed = (text: string) => {
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i)
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = text.charCodeAt(++i)
            if (!(next >= 0xdc00 && next <= 0xdfff)) return false
        } else if (code >= 0xdc00 && code <= 0xdfff) return false
    }
    return true
}

/** A seeded generator, so a failure repeats. */
const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** Code units weighted towards the cases JSON escapes or UTF-8 sizes differently. */
const pools: (() => string)[] = []
const randomString = (next: () => number, length: number) => {
    let out = ''
    for (let i = 0; i < length; i++)
        out += (pools[Math.floor(next() * pools.length)] as () => string)()
    return out
}
const unit = (next: () => number, from: number, to: number) =>
    String.fromCharCode(from + Math.floor(next() * (to - from + 1)))

const make = (next: () => number) => {
    pools.length = 0
    pools.push(
        () => unit(next, 0x00, 0x1f),
        () => '"',
        () => '\\',
        () => unit(next, 0x20, 0x7f),
        () => unit(next, 0x80, 0x7ff),
        () => unit(next, 0x800, 0xd7ff),
        () => unit(next, 0xe000, 0xffff),
        () => String.fromCodePoint(0x10000 + Math.floor(next() * 0x100000)),
        () => '😀',
        // Lone surrogates, high and low.
        () => unit(next, 0xd800, 0xdbff),
        () => unit(next, 0xdc00, 0xdfff),
        () => ' ',
    )
}

test('every single code unit and every pair counts as TextEncoder encodes it', () => {
    for (let code = 0; code <= 0xffff; code++) {
        const text = String.fromCharCode(code)
        assert.equal(utf8Length(text), encoded(text), `U+${code.toString(16)}`)
        const quoted = jsonStringBytes(text)
        if (isWellFormed(text)) assert.equal(quoted, encoded(JSON.stringify(text)))
        else assert.equal(quoted, undefined)
        for (const after of ['\ud800', '\udc00', '\ude00', 'a']) {
            const two = text + after
            assert.equal(utf8Length(two), encoded(two))
            if (isWellFormed(two)) assert.equal(jsonStringBytes(two), encoded(JSON.stringify(two)))
            else assert.equal(jsonStringBytes(two), undefined)
        }
    }
})

test('random strings count as TextEncoder encodes them and their JSON', () => {
    const next = random(7)
    make(next)
    for (let i = 0; i < 20_000; i++) {
        const text = randomString(next, Math.floor(next() * 40))
        assert.equal(utf8Length(text), encoded(text), JSON.stringify(text))
        if (isWellFormed(text)) assert.equal(jsonStringBytes(text), encoded(JSON.stringify(text)))
        else assert.equal(jsonStringBytes(text), undefined, JSON.stringify(text))
        // `jsonBytes` takes any string, lone surrogates included (JSON.stringify escapes them).
        assert.equal(jsonBytes(text), encoded(JSON.stringify(text)))
    }
})

test('the byte limit falls exactly where the encoded size of random values reaches it', () => {
    const next = random(11)
    make(next)
    const value = (depth: number): JsonValue => {
        const pick = next()
        if (depth > 3 || pick < 0.4) return randomString(next, Math.floor(next() * 12))
        if (pick < 0.5) return Math.floor(next() * 1e6) / 7
        if (pick < 0.55) return null
        if (pick < 0.6) return next() < 0.5
        if (pick < 0.8)
            return Array.from({ length: Math.floor(next() * 4) }, () => value(depth + 1))
        const object: Record<string, JsonValue> = {}
        for (let i = Math.floor(next() * 4); i > 0; i--)
            object[randomString(next, Math.floor(next() * 6))] = value(depth + 1)
        return object
    }
    let checked = 0
    for (let i = 0; i < 3000; i++) {
        const input = value(0)
        const text = JSON.stringify(input)
        assert.equal(jsonBytes(input), encoded(text))
        let wellFormed = true
        try {
            captureJson(input, { bytes: Infinity, depth: 64 })
        } catch {
            wellFormed = false
        }
        if (!wellFormed) continue
        const size = encoded(text)
        assert.equal(JSON.stringify(captureJson(input, { bytes: size, depth: 64 })), text)
        assert.throws(() => captureJson(input, { bytes: size - 1, depth: 64 }), /byte limit/)
        checked++
    }
    assert.ok(checked > 1000, `${checked} values checked`)
})
