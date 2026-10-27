import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { AssetImportError, type ImportErrorCode } from '../../../src/preview/assets/files/errors'
import {
    formatImportMessage,
    type ImportStrings,
} from '../../../src/preview/assets/files/importMessage'
import { importItem } from '../../../src/preview/assets/files/importer'
import { openSourcePackage } from '../../../src/preview/assets/files/package'
import type { AssetType } from '../../../src/preview/assets/types'
import {
    blobOf,
    concat,
    decodeTestAudio,
    decodeTestImage,
    effectData,
    gz,
    png,
    rawZip,
    scp,
    scpEntries,
    sizeEn,
    utf8,
    wav,
} from './fixtures'

// The size limits that only large files reach: each is refused by its own check.

const en = (
    JSON.parse(readFileSync('src/i18n/en/index.json', 'utf8')) as {
        commands: { previewAssets: ImportStrings }
    }
).commands.previewAssets
const message = (error: AssetImportError) =>
    formatImportMessage(error, en, (value) => new Intl.NumberFormat('en').format(value), sizeEn)

const refused = async (
    type: AssetType,
    bytes: Uint8Array,
    code: ImportErrorCode,
    text?: string,
    name = 'fixture',
) => {
    const pkg = await openSourcePackage(blobOf(bytes))
    try {
        await importItem(pkg, type, name, {
            maxTextureSide: 4096,
            decodeAudio: decodeTestAudio,
            decodeImage: decodeTestImage,
            signal: new AbortController().signal,
            origin: 'fixture.scp',
            now: () => 1,
        })
    } catch (error) {
        assert.ok(error instanceof AssetImportError, String(error))
        assert.equal(error.code, code, error.message)
        if (text !== undefined) assert.equal(message(error), text)
        return error
    }
    assert.fail('the package was accepted')
}

/** A real PNG with an ancillary chunk of `padding` bytes, which a decoder skips. */
const paddedPng = (padding: number) => {
    const image = png(64, 64)
    const chunk = new Uint8Array(12 + padding)
    const view = new DataView(chunk.buffer)
    view.setUint32(0, padding)
    chunk.set(utf8('zzZz'), 4)
    // CRC-32 over the type and the zeros.
    const crc = (bytes: Uint8Array) => {
        let c = ~0
        for (const byte of bytes) {
            c ^= byte
            for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
        }
        return ~c >>> 0
    }
    view.setUint32(8 + padding, crc(chunk.subarray(4, 8 + padding)))
    // After the header, before the end.
    return concat(image.subarray(0, 33), chunk, image.subarray(33))
}

test('a list or details entry over 4 MB is refused', async () => {
    const entries = scpEntries('skin')
    const details = entries.findIndex((entry) => entry.name === 'sonolus/skins/fixture')
    const item = JSON.parse(new TextDecoder().decode(entries[details]!.data)) as object
    entries[details] = {
        name: 'sonolus/skins/fixture',
        data: utf8(JSON.stringify({ ...item, padding: 'x'.repeat(4_000_001) })),
        method: 0,
    }
    await refused(
        'skin',
        rawZip(entries),
        'tooBig',
        'This file’s skin detail entry is larger than 4 MB.',
    )
})

test('data over 16 MB gzipped, or 64 MB inflated, is refused', async () => {
    await refused(
        'skin',
        scp('skin', { resources: { data: new Uint8Array(randomBytes(16_000_001)) } }),
        'tooBig',
        'This file’s skin data is larger than 16 MB.',
    )
    await refused(
        'skin',
        scp('skin', { resources: { data: new Uint8Array(gzipSync(new Uint8Array(64_000_001))) } }),
        'tooBig',
        'This file’s skin data is larger than 64 MB.',
    )
})

test('an item over 64 MB once repacked is refused', async () => {
    // Each part under its own cap: a 56 MB texture, and about 9 MB of data that does not compress.
    const data = JSON.stringify({
        width: 64,
        height: 64,
        sprites: [{ name: 'Sekai Normal Note Middle', x: 0, y: 0, w: 16, h: 16, transform: {} }],
        padding: randomBytes(7_000_000).toString('base64'),
    })
    await refused(
        'skin',
        scp('skin', {
            resources: {
                texture: paddedPng(56_000_000),
                data: new Uint8Array(gzipSync(utf8(data), { level: 0 })),
            },
        }),
        'packageTooLarge',
        'This item is larger than 64 MB once stored.',
    )
})

const effectWith = (audio: Uint8Array) =>
    scp('effect', { resources: { data: gz(effectData()), audio } })

test('the sound effects audio has its own caps: 32 MB, 8 MB a clip, and the ratio', async () => {
    await refused(
        'effect',
        effectWith(new Uint8Array(randomBytes(32_000_001))),
        'tooBig',
        'This file’s sound effects audio is larger than 32 MB.',
    )
    // A clip over 8 MB cannot be read.
    await refused(
        'effect',
        effectWith(rawZip([{ name: 'perfect.mp3', data: wav(1001), method: 0 }])),
        'unreadable',
        'This file’s sound effects audio could not be read.',
    )
    // A clip that inflates more than 200 times.
    await refused(
        'effect',
        effectWith(rawZip([{ name: 'perfect.mp3', data: wav(100), method: 8 }])),
        'ratio',
        'This file’s sound effects audio expands to more than 200 times its compressed size.',
    )
})
