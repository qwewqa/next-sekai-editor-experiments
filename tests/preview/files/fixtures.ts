import { createHash } from 'node:crypto'
import { deflateRawSync, gzipSync } from 'node:zlib'
import type { AssetType } from '../../../src/preview/assets/types'
import { concat, rawZip, utf8, type RawEntry } from '../../zip/rawZip'

// Small Sonolus packages for the From a File tests: a valid item of each type, with one knob
// per way a package can be wrong.

export const sha1 = (bytes: Uint8Array) => createHash('sha1').update(bytes).digest('hex')

const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]

/** A PNG's signature and IHDR only: enough for a header check, which never decodes it. */
export const pngHeader = (width: number, height: number) =>
    Uint8Array.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        ...u32be(13),
        0x49,
        0x48,
        0x44,
        0x52,
        ...u32be(width),
        ...u32be(height),
        8,
        6,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
    ])

/** A JPEG's start, a comment and a start-of-frame segment with the size. */
export const jpegHeader = (width: number, height: number) =>
    Uint8Array.from([
        0xff,
        0xd8,
        0xff,
        0xfe,
        0x00,
        0x04,
        0x61,
        0x62,
        0xff,
        0xc0,
        0x00,
        0x0b,
        8,
        (height >> 8) & 255,
        height & 255,
        (width >> 8) & 255,
        width & 255,
        1,
        1,
        0x11,
        0,
    ])

export const gz = (value: unknown) => new Uint8Array(gzipSync(JSON.stringify(value)))

const identity = Object.fromEntries(
    ['x1', 'x2', 'x3', 'x4', 'y1', 'y2', 'y3', 'y4'].map((key) => [key, { [key]: 1 }]),
)

export const skinData = (overrides: Record<string, unknown> = {}) => ({
    width: 64,
    height: 64,
    interpolation: true,
    sprites: [
        { name: 'Sekai Note Tap', x: 0, y: 0, w: 16, h: 16, transform: identity },
        { name: 'Sekai Note Flick', x: 16, y: 0, w: 16, h: 16, transform: identity },
    ],
    ...overrides,
})

const particleProperty = { from: { c: 0 }, to: { c: 1 }, ease: 'linear' }
export const particleData = (overrides: Record<string, unknown> = {}) => ({
    width: 64,
    height: 64,
    interpolation: false,
    sprites: [{ x: 0, y: 0, w: 16, h: 16 }],
    effects: [
        {
            name: 'Sekai Note Tap',
            transform: identity,
            groups: [
                {
                    count: 2,
                    particles: [
                        {
                            sprite: 0,
                            color: '#ffffff',
                            start: 0,
                            duration: 0.5,
                            x: particleProperty,
                            y: particleProperty,
                            w: particleProperty,
                            h: particleProperty,
                            r: particleProperty,
                            a: particleProperty,
                        },
                    ],
                },
            ],
        },
    ],
    ...overrides,
})

export const backgroundData = (overrides: Record<string, unknown> = {}) => ({
    fit: 'cover',
    color: '#102030',
    ...overrides,
})

export const backgroundConfiguration = { blur: 4, mask: '#00000040' }

const BAD = utf8('bad!')

/**
 * A real WAV of 8-bit mono PCM at 8 kHz, `seconds` long. A `bad` one starts its samples with a
 * mark that `decodeTestAudio` refuses, as a decoder refuses a broken body.
 */
export const wav = (seconds: number, bad = false) => {
    const frames = Math.round(seconds * 8000)
    const bytes = new Uint8Array(44 + frames).fill(128, 44)
    const view = new DataView(bytes.buffer)
    bytes.set(utf8('RIFF'), 0)
    view.setUint32(4, 36 + frames, true)
    bytes.set(utf8('WAVEfmt '), 8)
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, 8000, true)
    view.setUint32(28, 8000, true)
    view.setUint16(32, 1, true)
    view.setUint16(34, 8, true)
    bytes.set(utf8('data'), 36)
    view.setUint32(40, frames, true)
    if (bad) bytes.set(BAD, 44)
    return bytes
}

/** A decoder for the tests: a WAV from `wav` decodes to its length, at 44.1 kHz. */
export const decodeTestAudio = async (data: ArrayBuffer): Promise<AudioBuffer> => {
    const bytes = new Uint8Array(data)
    const text = new TextDecoder().decode(bytes.subarray(0, 4))
    if (text !== 'RIFF' || BAD.every((byte, i) => bytes[44 + i] === byte))
        throw new Error('Unable to decode audio data')
    const duration = (bytes.length - 44) / 8000
    const length = Math.round(duration * 44100)
    return { duration, length, numberOfChannels: 1, sampleRate: 44100 } as AudioBuffer
}

/** The audio package of an effect: one entry per clip, named as the data names it. */
export const audioZip = (clips: Record<string, Uint8Array> = { 'perfect.mp3': wav(1) }) =>
    rawZip(Object.entries(clips).map(([name, data]): RawEntry => ({ name, data, method: 0 })))

export const effectData = (overrides: Record<string, unknown> = {}) => ({
    clips: [{ name: '#PERFECT', filename: 'perfect.mp3' }],
    ...overrides,
})

export type NamedEntry = RawEntry & { name: string }

export type Hashes = 'good' | 'bad' | 'malformed' | 'null' | 'omit'

export type ScpOptions = {
    name?: string
    title?: string
    /** Replaces a resource's bytes by field. */
    resources?: Partial<
        Record<'data' | 'texture' | 'image' | 'configuration' | 'audio' | 'thumbnail', Uint8Array>
    >
    /** How the SRLs name their hashes. */
    hashes?: Hashes
    /** Extra fields on the item. */
    item?: Record<string, unknown>
    /** Omit the details entry, so the list stands in for it. */
    noDetails?: boolean
    /** Entries added to the package. */
    extra?: NamedEntry[]
}

const defaults = (type: AssetType): Record<string, Uint8Array> => {
    switch (type) {
        case 'skin':
            return { data: gz(skinData()), texture: pngHeader(64, 64) }
        case 'particle':
            return { data: gz(particleData()), texture: pngHeader(64, 64) }
        case 'background':
            return {
                data: gz(backgroundData()),
                image: pngHeader(160, 90),
                configuration: gz(backgroundConfiguration),
            }
        case 'effect':
            return { data: gz(effectData()), audio: audioZip() }
    }
}

const categories = {
    skin: 'skins',
    particle: 'particles',
    background: 'backgrounds',
    effect: 'effects',
} as const

/** The entries of a standard single-item package of a type. */
export const scpEntries = (type: AssetType, options: ScpOptions = {}): NamedEntry[] => {
    const name = options.name ?? 'fixture'
    const resources: Record<string, Uint8Array> = {
        ...defaults(type),
        thumbnail: pngHeader(32, 32),
        ...options.resources,
    }
    const hashes = options.hashes ?? 'good'
    const entries: NamedEntry[] = []
    const item: Record<string, unknown> = {
        name,
        version: 1,
        title: options.title ?? 'Fixture',
        subtitle: 'Subtitle',
        author: 'Author',
        tags: [],
    }
    for (const [field, bytes] of Object.entries(resources)) {
        const hash = sha1(bytes)
        const url = `/sonolus/repository/${hash}`
        item[field] =
            hashes === 'good'
                ? { hash, url }
                : hashes === 'bad'
                  ? { hash: sha1(utf8(`other ${hash}`)), url }
                  : hashes === 'malformed'
                    ? { hash: 'not-a-sha1', url }
                    : hashes === 'null'
                      ? { hash: null, url }
                      : { url }
        entries.push({ name: `sonolus/repository/${hash}`, data: bytes, method: 0 })
    }
    Object.assign(item, options.item)
    const category = categories[type]
    entries.unshift({
        name: `sonolus/${category}/list`,
        data: utf8(JSON.stringify({ pageCount: 1, items: [item] })),
    })
    if (!options.noDetails)
        entries.push({
            name: `sonolus/${category}/${name}`,
            data: utf8(JSON.stringify({ item, description: '' })),
        })
    return [...entries, ...(options.extra ?? [])]
}

/** A valid package of a type, as bytes. */
export const scp = (type: AssetType, options: ScpOptions = {}) => rawZip(scpEntries(type, options))

export const blobOf = (bytes: Uint8Array) => new Blob([new Uint8Array(bytes)])

/** One package holding several items, as a collection does; entries two items share are kept once. */
export const scpMulti = (items: [AssetType, ScpOptions?][]) => {
    const entries = new Map<string, NamedEntry>()
    for (const [type, options] of items)
        for (const entry of scpEntries(type, options)) {
            const before = entries.get(entry.name)
            if (before && entry.name.endsWith('/list')) {
                // Two items of a type share one list.
                const list = JSON.parse(new TextDecoder().decode(before.data)) as {
                    items: unknown[]
                }
                const more = JSON.parse(new TextDecoder().decode(entry.data)) as {
                    items: unknown[]
                }
                list.items.push(...more.items)
                entries.set(entry.name, { ...entry, data: utf8(JSON.stringify(list)) })
            } else entries.set(entry.name, entry)
        }
    return rawZip([...entries.values()])
}

export { concat, deflateRawSync, rawZip, utf8 }
