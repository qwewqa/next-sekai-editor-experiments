import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import {
    LevelUnreadableError,
    openErrorText,
    RefusedFileError,
    type OpenErrorStrings,
} from '../../src/editor/commands/open/levelData'
import {
    isBlackPng,
    isSilentMp3,
    readLevelData,
    readMedia,
} from '../../src/editor/commands/open/packageData'
import { readInventory } from '../../src/files/package/inventory'
import { COVER_MAX_SIDE, readCoverSize } from '../../src/local/media'
import { scpBlackPng, scpSilentMp3 } from '../../src/local/nxsp/scpMedia'
import { levelData, levelPackage, type LevelSpec } from '../browser/levelPackages'
import { entriesOf, rawZip, utf8 } from '../browser/previewAssetsPackages'
import { entity, minimalLevel } from './levelDataSynthetic'

// A package level's data through Open's level-data dispatch, and the message each failure shows.

const strings = JSON.parse(
    readFileSync(new URL('../../src/i18n/en/index.json', import.meta.url), 'utf8'),
) as {
    commands: { open: Omit<OpenErrorStrings, 'levelUnreadable' | 'fileUnreadable'> }
    open: { package: { levelUnreadable: string } }
}
const english = {
    ...strings.commands.open,
    levelUnreadable: strings.open.package.levelUnreadable,
    fileUnreadable: 'This file could not be read.',
}
const en = {
    unreadable: 'This level’s data could not be read.',
    noBpm: 'Invalid level: initial BPM not found',
}

const opened = async (bytes: Uint8Array) => {
    const inventory = await readInventory(new Blob([new Uint8Array(bytes)]))
    const level = inventory.levels[0]
    assert.ok(level)
    return { pkg: inventory.pkg, level }
}

const read = async (spec: Omit<LevelSpec, 'name'>) => {
    const { pkg, level } = await opened(await levelPackage('full', [{ name: 'song', ...spec }]))
    return readLevelData(pkg, level.item)
}

// The class decides the open's outcome; the dialog shows its text.
const refusedWith =
    (message: string, kind: abstract new (...args: never[]) => Error) => (error: unknown) =>
        error instanceof kind && openErrorText(error, english) === message

test('Next SEKAI level data opens; Chart Cyanvas level data takes its own path', async () => {
    const parsed = await read({})
    assert.equal(parsed.type, 'levelData')
    assert.ok(parsed.type === 'levelData' && parsed.report.isEmpty)

    const chcy = await read({
        data: levelData([
            entity('Initialization', {}),
            entity('TimeScaleGroup', { first: { ref: 'tsc' }, length: 1, next: -1 }, 'tsg'),
            entity('TimeScaleChange', { '#BEAT': 0, timeScale: 1, next: -1 }, 'tsc'),
            entity('#BPM_CHANGE', { '#BEAT': 0, '#BPM': 120 }),
        ]),
    })
    assert.equal(chcy.type, 'chcy')
    // Plain JSON is read too.
    const plain = await read({
        data: utf8(JSON.stringify({ bgmOffset: 0.5, entities: minimalLevel() })),
    })
    assert.equal(plain.offset, 0.5)
})

test('every failure to read the data is one message, without a raw code', async () => {
    const rows: [string, () => Promise<unknown>][] = [
        ['a wrong SRL hash', () => read({ hashes: 'bad' })],
        ['a gzip that fails', () => read({ data: new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3]) })],
        ['not JSON', () => read({ data: new Uint8Array(gzipSync('not json')) })],
        ['no entities', () => read({ data: new Uint8Array(gzipSync('{"bgmOffset":0}')) })],
        ['refused by the schema', () => read({ data: new Uint8Array(gzipSync('{"entities":5}')) })],
    ]
    // The package reader's own refusals: CRC, a name two entries share, the ratio guard.
    const entries = await entriesOf(await levelPackage('full', [{ name: 'song' }]))
    const [dataPath] = [...entries.keys()].filter((name) => name.startsWith('sonolus/repository/'))
    assert.ok(dataPath)
    const damaged = (extra: Partial<Parameters<typeof rawZip>[0][number]>, data?: Uint8Array) =>
        rawZip(
            [...entries].map(([name, bytes]) => ({
                name,
                data: name === dataPath && data ? data : bytes,
                method: 0 as const,
                ...(name === dataPath ? extra : {}),
            })),
        )
    const readFrom = async (bytes: Uint8Array) => {
        const { pkg, level } = await opened(bytes)
        return readLevelData(pkg, level.item)
    }
    rows.push(['a bad CRC', () => readFrom(damaged({ central: { crc32: 1 } }))])
    rows.push([
        'two entries of the name',
        () =>
            readFrom(
                rawZip([
                    ...[...entries].map(([name, data]) => ({ name, data, method: 0 as const })),
                    { name: dataPath, data: entries.get(dataPath)!, method: 0 },
                ]),
            ),
    ])
    // A megabyte that deflates to almost nothing: refused before it inflates.
    rows.push([
        'past the ratio guard',
        () => readFrom(damaged({ method: 8 }, new Uint8Array(1 << 20))),
    ])
    for (const [label, attempt] of rows)
        await assert.rejects(attempt(), refusedWith(en.unreadable, LevelUnreadableError), label)
})

test('a chart that cannot be built is refused with its reason', async () => {
    await assert.rejects(
        read({
            data: levelData(minimalLevel().filter((item) => item.archetype !== '#BPM_CHANGE')),
        }),
        refusedWith(en.noBpm, RefusedFileError),
    )
})

test('a BPM at beat 0 with only unknown note archetypes opens as tempo only, parts left out', async () => {
    const parsed = await read({
        data: levelData([
            entity('Initialization', { initialLife: 1000, revision: 2 }),
            entity('#BPM_CHANGE', { '#BEAT': 0, '#BPM': 120 }),
            entity('PySekaiTapNote', { '#BEAT': 1, lane: 0, size: 1 }),
        ]),
    })
    assert.equal(parsed.type, 'levelData')
    assert.ok(parsed.type === 'levelData' && !parsed.report.isEmpty)
})

test('media: none named, in the file, unusable, and the placeholders read as none', async () => {
    const png = scpBlackPng()
    const real = new Uint8Array([...png.subarray(0, 16), 0, 0, 0, 2, ...png.subarray(20)])
    const { pkg, level } = await opened(
        await levelPackage('full', [
            { name: 'song', cover: real, bgm: scpSilentMp3(1, 1 << 20), preview: utf8('x') },
        ]),
    )
    assert.equal((await readMedia(pkg, level.item, 'cover')).kind, 'bytes')
    assert.equal((await readMedia(pkg, level.item, 'bgm')).kind, 'none')
    const placeholder = await opened(await levelPackage('full', [{ name: 'p', cover: png }]))
    assert.equal((await readMedia(placeholder.pkg, placeholder.level.item, 'cover')).kind, 'none')
    // `{}` is a known absence; an external URL, a missing entry or a bad hash is not usable.
    const item = (srl: unknown) => ({ ...level.item, cover: srl })
    assert.equal((await readMedia(pkg, item({}), 'cover')).kind, 'none')
    assert.equal(
        (await readMedia(pkg, item({ url: 'https://example.com/c' }), 'cover')).kind,
        'unusable',
    )
    assert.equal(
        (await readMedia(pkg, item({ url: '/sonolus/repository/none' }), 'cover')).kind,
        'unusable',
    )
    const bad = await opened(
        await levelPackage('full', [{ name: 'b', cover: real, hashes: 'bad' }]),
    )
    assert.equal((await readMedia(bad.pkg, bad.level.item, 'cover')).kind, 'unusable')
})

test('the placeholders are recognised only exactly', () => {
    assert.ok(isBlackPng(scpBlackPng()))
    assert.ok(isSilentMp3(scpSilentMp3(3, 1 << 20)))
    const sound = scpSilentMp3(1, 1 << 20)
    sound[200] = 1
    assert.ok(!isSilentMp3(sound))
    assert.ok(!isSilentMp3(new Uint8Array(143)))
    const png = scpBlackPng()
    png[png.length - 1] = (png[png.length - 1] ?? 0) ^ 1
    assert.ok(!isBlackPng(png))
})

test('a cover header gives its size for PNG, JPEG, GIF and WebP', () => {
    const png = scpBlackPng()
    assert.deepEqual(readCoverSize(png), { width: 1, height: 1 })
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0x01, 0x02, 0x03, 0x04, 3])
    assert.deepEqual(readCoverSize(jpeg), { width: 0x0304, height: 0x0102 })
    const gif = new Uint8Array([...utf8('GIF89a'), 0x10, 0x00, 0x20, 0x00, 0, 0])
    assert.deepEqual(readCoverSize(gif), { width: 16, height: 32 })
    const webp = (chunk: string, body: number[]) =>
        new Uint8Array([
            ...utf8('RIFF'),
            0,
            0,
            0,
            0,
            ...utf8('WEBP'),
            ...utf8(chunk),
            0,
            0,
            0,
            0,
            ...body,
            ...new Array(16).fill(0),
        ])
    // VP8: a frame tag, the start code, then 14-bit sides.
    assert.deepEqual(
        readCoverSize(webp('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xf0, 0x00])),
        {
            width: 320,
            height: 240,
        },
    )
    // VP8L: the signature, then width - 1 and height - 1 in 14 bits each.
    const w = 99
    const h = 49
    const bits = w | (h << 14)
    assert.deepEqual(
        readCoverSize(
            webp('VP8L', [
                0x2f,
                bits & 0xff,
                (bits >> 8) & 0xff,
                (bits >> 16) & 0xff,
                (bits >> 24) & 0xff,
            ]),
        ),
        { width: 100, height: 50 },
    )
    // VP8X: flags, then 24-bit canvas sides less one.
    const side = COVER_MAX_SIDE // one more than the limit, as stored less one
    assert.deepEqual(
        readCoverSize(webp('VP8X', [0, 0, 0, 0, side & 0xff, (side >> 8) & 0xff, 0, 0, 0, 0])),
        { width: COVER_MAX_SIDE + 1, height: 1 },
    )
    // Cut off, or another format: undefined, or only decoding can tell.
    assert.equal(readCoverSize(png.subarray(0, 20)), undefined)
    assert.equal(readCoverSize(gif.subarray(0, 8)), undefined)
    assert.equal(readCoverSize(webp('VP8 ', [0, 0, 0, 0x9d]).subarray(0, 24)), undefined)
    assert.equal(readCoverSize(utf8('BM some bitmap')), 'unknown')
})
