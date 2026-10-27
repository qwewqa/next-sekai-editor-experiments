import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { AssetImportError, type ImportErrorCode } from '../../../src/preview/assets/files/errors'
import type { ImportStrings } from '../../../src/preview/assets/files/importMessage'
import { formatImportMessage } from '../../../src/preview/assets/files/importMessage'
import { importItem, type ImportContext } from '../../../src/preview/assets/files/importer'
import { checkItem } from '../../../src/preview/assets/files/item'
import { openSourcePackage } from '../../../src/preview/assets/files/package'
import type { AssetType } from '../../../src/preview/assets/types'
import {
    audioZip,
    backgroundData,
    blobOf,
    brokenPng,
    decodeTestAudio,
    decodeTestImage,
    effectData,
    gz,
    jpegHeader,
    particleData,
    png,
    pngHeader,
    rawZip,
    scp,
    scpEntries,
    sha1,
    sizeEn,
    skinData,
    utf8,
    wav,
    type ScpOptions,
} from './fixtures'

const en = (
    JSON.parse(readFileSync('src/i18n/en/index.json', 'utf8')) as {
        commands: { previewAssets: ImportStrings }
    }
).commands.previewAssets
const importMessage = (error: AssetImportError) =>
    formatImportMessage(error, en, (value) => new Intl.NumberFormat('en').format(value), sizeEn)

// Rejection at import: each way a package can be wrong is refused with a
// plain message that names the problem.

const decodeAudio = decodeTestAudio

const context = (overrides: Partial<ImportContext> = {}): ImportContext => ({
    maxTextureSide: 4096,
    decodeAudio,
    decodeImage: decodeTestImage,
    signal: new AbortController().signal,
    origin: 'fixture.scp',
    now: () => 1000,
    ...overrides,
})

/** Imports a package's only item, resolving to the error it is refused with. */
const refuse = async (
    type: AssetType,
    bytes: Uint8Array | Blob,
    overrides: Partial<ImportContext> = {},
) => {
    try {
        const file = bytes instanceof Uint8Array ? blobOf(bytes) : bytes
        const pkg = await openSourcePackage(file)
        await importItem(pkg, type, 'fixture', context(overrides))
    } catch (error) {
        assert.ok(error instanceof AssetImportError, `a plain error: ${String(error)}`)
        return error
    }
    assert.fail('the package was accepted')
}

const expectRefused = async (
    type: AssetType,
    bytes: Uint8Array | Blob,
    code: ImportErrorCode,
    message?: string,
    overrides: Partial<ImportContext> = {},
) => {
    const error = await refuse(type, bytes, overrides)
    assert.equal(error.code, code, error.message)
    if (message !== undefined) assert.equal(importMessage(error), message)
    return error
}

const valid = (type: AssetType, options?: ScpOptions) => scp(type, options)

test('a valid item of each type imports to a standard single-item package', async () => {
    for (const type of ['skin', 'particle', 'background', 'effect'] as const) {
        const pkg = await openSourcePackage(blobOf(valid(type)))
        const record = await importItem(pkg, type, 'fixture', context())
        assert.match(record.key, /^[0-9a-f]{64}$/)
        assert.equal(record.type, type)
        assert.equal(record.title, 'Fixture')
        assert.equal(record.author, 'Author')
        assert.equal(record.origin, 'fixture.scp')
        assert.equal(record.size, record.bytes.size)

        // The stored package reads back through the same reader, under the load checks.
        const stored = await openSourcePackage(record.bytes)
        const listed = await stored.list(type)
        assert.deepEqual(
            listed.map((item) => item.name),
            ['fixture'],
        )
        const checked = await checkItem(stored, type, 'fixture', {
            mode: 'load',
            maxTextureSide: 4096,
        })
        assert.equal(checked.title, 'Fixture')

        // Importing the same item again gives the same bytes, so the same name.
        const again = await importItem(pkg, type, 'fixture', context({ now: () => 2000 }))
        assert.equal(again.key, record.key)
    }
})

test('a bad end record is refused', async () => {
    const bytes = valid('skin')
    await expectRefused(
        'skin',
        bytes.slice(0, bytes.length - 10),
        'damaged',
        'This file is damaged or is not a Sonolus package.',
    )
    await expectRefused('skin', utf8('this is not a zip file at all'), 'damaged')
    // The end record is there but its directory offset points past the file.
    const bent = bytes.slice()
    new DataView(bent.buffer).setUint32(bent.length - 6, 0x7fffffff, true)
    await expectRefused('skin', bent, 'damaged')
})

test('ZIP64 is refused', async () => {
    const bytes = rawZip(scpEntries('skin'), { zip64End: true })
    await expectRefused('skin', bytes, 'zip64', 'The editor cannot read ZIP64 files.')
})

test('ZIP64 fields in an entry of a ZIP32 file are refused', async () => {
    const entries = scpEntries('skin').map((entry) =>
        entry.name.startsWith('sonolus/repository/') ? { ...entry, zip64: true } : entry,
    )
    await expectRefused('skin', rawZip(entries), 'zip64')
})

test('an entry name over 1 KiB is refused', async () => {
    await expectRefused(
        'skin',
        rawZip([...scpEntries('skin'), { name: `long/${'n'.repeat(1100)}`, data: utf8('x') }]),
        'badName',
    )
})

test('a ratio bomb is refused before anything inflates', async () => {
    // 30 MB of zeros deflate to about 30 kB: more than 200 to 1.
    const zeros = new Uint8Array(30_000_000)
    const entries = scpEntries('skin', { resources: { texture: zeros } }).map((entry) =>
        entry.data.length === zeros.length ? { ...entry, method: 8 as const } : entry,
    )
    const error = await expectRefused('skin', rawZip(entries), 'ratio')
    assert.equal(error.detail.part, 'texture')
    assert.equal(
        importMessage(error),
        'This file’s skin texture expands to more than 200 times its compressed size.',
    )
})

test('an entry that inflates past what it declares is refused', async () => {
    const zeros = new Uint8Array(1_000_000)
    const entries = scpEntries('skin', { resources: { texture: zeros } }).map((entry) =>
        entry.data.length === zeros.length
            ? { ...entry, method: 8 as const, central: { size: 70_000 } }
            : entry,
    )
    // The declared size is under the ratio floor, so only the inflate catches it.
    await expectRefused('skin', rawZip(entries), 'damaged')
})

test('invalid JSON is refused, in an entry and in a gzipped data file', async () => {
    await expectRefused(
        'skin',
        valid('skin', { resources: { data: new Uint8Array(gzipSync('this is not json')) } }),
        'unreadable',
        'This file’s skin data could not be read.',
    )
    await expectRefused(
        'skin',
        valid('skin', { resources: { data: utf8('not gzip data either') } }),
        'unreadable',
    )
    // With no details entry the list stands in, and it is not JSON.
    const entries = scpEntries('skin', { noDetails: true })
    entries[0] = { name: entries[0]!.name, data: utf8('{"items": [') }
    const error = await expectRefused('skin', rawZip(entries), 'unreadable')
    assert.equal(error.detail.part, 'list')
})

test('a wrong schema is refused for each type', async () => {
    await expectRefused(
        'skin',
        valid('skin', { resources: { data: gz({ width: 'wide', height: 64, sprites: [] }) } }),
        'unreadable',
    )
    await expectRefused(
        'skin',
        valid('skin', { resources: { data: gz(skinData({ sprites: [{ name: 'x' }] })) } }),
        'unreadable',
    )
    await expectRefused(
        'particle',
        valid('particle', { resources: { data: gz({ ...particleData(), effects: 'none' }) } }),
        'unreadable',
    )
    await expectRefused(
        'background',
        valid('background', { resources: { data: gz(backgroundData({ fit: 'stretch' })) } }),
        'unreadable',
    )
    await expectRefused(
        'background',
        valid('background', {
            resources: { configuration: gz({ blur: 'lots', mask: '#000000' }) },
        }),
        'unreadable',
    )
    await expectRefused(
        'effect',
        valid('effect', { resources: { data: gz({ clips: [{ name: 1 }] }) } }),
        'unreadable',
    )
})

test('NaN and infinite numbers are refused', async () => {
    // JSON has no NaN, so a file that writes one is not JSON; 1e999 parses to Infinity.
    const withNaN = `{"width":64,"height":64,"interpolation":true,"sprites":[{"name":"a","x":NaN,"y":0,"w":1,"h":1}]}`
    await expectRefused(
        'skin',
        valid('skin', { resources: { data: new Uint8Array(gzipSync(withNaN)) } }),
        'unreadable',
    )
    const infinite = `{"width":64,"height":64,"interpolation":true,"sprites":[{"name":"a","x":1e999,"y":0,"w":1,"h":1}]}`
    await expectRefused(
        'skin',
        valid('skin', { resources: { data: new Uint8Array(gzipSync(infinite)) } }),
        'unreadable',
    )
})

test('an SRL hash that does not match is refused', async () => {
    await expectRefused(
        'skin',
        valid('skin', { hashes: 'bad' }),
        'checksum',
        'This file’s skin thumbnail does not match its checksum.',
    )
    // Only the data's hash is wrong.
    const data = gz(skinData())
    await expectRefused(
        'skin',
        valid('skin', {
            item: { data: { hash: 'f'.repeat(40), url: '/sonolus/repository/' + sha1(data) } },
        }),
        'checksum',
        'This file’s skin data does not match its checksum.',
    )
    // A hash that is present must be 40 hex characters.
    await expectRefused('skin', valid('skin', { hashes: 'malformed' }), 'checksum')
})

test('null and absent SRL fields mean the same, and are accepted', async () => {
    for (const hashes of ['null', 'omit'] as const)
        for (const type of ['skin', 'particle', 'background', 'effect'] as const) {
            const pkg = await openSourcePackage(blobOf(valid(type, { hashes })))
            const record = await importItem(pkg, type, 'fixture', context())
            assert.equal(record.type, type)
        }
    // A thumbnail whose URL is null is no thumbnail.
    const pkg = await openSourcePackage(
        blobOf(valid('skin', { item: { thumbnail: { hash: null, url: null } } })),
    )
    assert.equal((await importItem(pkg, 'skin', 'fixture', context())).type, 'skin')
})

test('oversized images are refused from their headers alone', async () => {
    await expectRefused(
        'skin',
        valid('skin', { resources: { texture: pngHeader(8192, 8192) } }),
        'imageSize',
        'This file’s skin texture is 8192 × 8192. The limit is 4096 × 4096.',
    )
    await expectRefused(
        'particle',
        valid('particle', { resources: { texture: pngHeader(4097, 16) } }),
        'imageSize',
    )
    await expectRefused(
        'background',
        valid('background', { resources: { image: jpegHeader(5000, 3000) } }),
        'imageSize',
        'This file’s background image is 5000 × 3000. The limit is 4096 × 4096.',
    )
    await expectRefused(
        'skin',
        valid('skin', { resources: { thumbnail: pngHeader(2000, 2000) } }),
        'imageSize',
        'This file’s skin thumbnail is 2000 × 2000. The limit is 1024 × 1024.',
    )
    // The device's own limit applies when it is smaller.
    await expectRefused(
        'skin',
        valid('skin', { resources: { texture: pngHeader(4096, 4096) } }),
        'imageSize',
        'This file’s skin texture is 4096 × 4096. The limit is 2048 × 2048.',
        { maxTextureSide: 2048 },
    )
    await expectRefused(
        'skin',
        valid('skin', { resources: { texture: utf8('plain text, not an image') } }),
        'notImage',
        'This file’s skin texture is not a PNG or JPEG image.',
    )
})

test('an image whose body does not decode is refused, and only once its size passed', async () => {
    await expectRefused(
        'skin',
        valid('skin', { resources: { texture: brokenPng(64, 64) } }),
        'unreadable',
        'This file’s skin texture could not be read.',
    )
    // A header with no body at all.
    await expectRefused(
        'particle',
        valid('particle', { resources: { texture: pngHeader(64, 64) } }),
        'unreadable',
    )
    await expectRefused(
        'background',
        valid('background', { resources: { image: brokenPng(160, 90) } }),
        'unreadable',
        'This file’s background image could not be read.',
    )
    // The size cap comes first: an image over it is never decoded.
    let decoded = 0
    await expectRefused(
        'skin',
        valid('skin', { resources: { texture: png(8192, 8) } }),
        'imageSize',
        undefined,
        {
            decodeImage: async (bytes) => {
                decoded++
                await decodeTestImage(bytes)
            },
        },
    )
    assert.equal(decoded, 0)
})

test('a sprite outside its texture is refused', async () => {
    await expectRefused(
        'skin',
        valid('skin', {
            resources: {
                data: gz(
                    skinData({
                        sprites: [{ name: 'a', x: 60, y: 0, w: 16, h: 16, transform: {} }],
                    }),
                ),
            },
        }),
        'spriteOutside',
        'This file’s skin data has a sprite outside its texture.',
    )
    await expectRefused(
        'particle',
        valid('particle', {
            resources: { data: gz(particleData({ sprites: [{ x: 0, y: 50, w: 16, h: 16 }] })) },
        }),
        'spriteOutside',
    )
})

test('a skin with no note body sprite is refused', async () => {
    await expectRefused(
        'skin',
        valid('skin', {
            resources: {
                data: gz(
                    skinData({
                        sprites: [{ name: 'a', x: 0, y: 0, w: 16, h: 16, transform: {} }],
                    }),
                ),
            },
        }),
        'noNoteSprites',
        'This file’s skin has no note sprites.',
    )
})

test('too many sprites or effects are refused', async () => {
    const sprites = Array.from({ length: 20_001 }, (_, i) => ({
        name: `s${i}`,
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        transform: {},
    }))
    await expectRefused(
        'skin',
        valid('skin', { resources: { data: gz(skinData({ sprites })) } }),
        'tooManySprites',
        'This file’s skin data has more than 20,000 sprites.',
    )
    const rects = Array.from({ length: 4097 }, () => ({ x: 0, y: 0, w: 1, h: 1 }))
    await expectRefused(
        'particle',
        valid('particle', { resources: { data: gz(particleData({ sprites: rects })) } }),
        'tooManySprites',
    )
    const effects = Array.from({ length: 4097 }, (_, i) => ({
        ...particleData().effects[0],
        name: `e${i}`,
    }))
    await expectRefused(
        'particle',
        valid('particle', { resources: { data: gz(particleData({ effects })) } }),
        'tooManyEffects',
    )
})

test('a particle effect over 512 particles is refused', async () => {
    const [effect] = particleData().effects
    assert.ok(effect)
    const [group] = effect.groups
    assert.ok(group)
    const over = { ...effect, groups: [{ ...group, count: 513 }] }
    await expectRefused(
        'particle',
        valid('particle', { resources: { data: gz(particleData({ effects: [over] })) } }),
        'particleCount',
        'This file’s particle effect "Sekai Note Tap" has more than 512 particles.',
    )
    // Exactly at the cap is fine.
    const pkg = await openSourcePackage(
        blobOf(
            valid('particle', {
                resources: {
                    data: gz(
                        particleData({
                            effects: [{ ...effect, groups: [{ ...group, count: 512 }] }],
                        }),
                    ),
                },
            }),
        ),
    )
    assert.equal((await importItem(pkg, 'particle', 'fixture', context())).type, 'particle')
})

/** A particle package whose only effect has these groups, and maybe more effects. */
const particleWith = (groups: unknown[], effects = 1) => {
    const [effect] = particleData().effects
    assert.ok(effect)
    return valid('particle', {
        resources: {
            data: gz(
                particleData({
                    effects: Array.from({ length: effects }, (_, i) => ({
                        ...effect,
                        name: i ? `e${i}` : effect.name,
                        groups,
                    })),
                }),
            ),
        },
    })
}

test('particle shapes that dodge count × particles are refused', async () => {
    const [particle] = particleData().effects[0]!.groups[0]!.particles
    // A huge count with no particles still walks every occurrence.
    await expectRefused(
        'particle',
        particleWith([{ count: 1e15, particles: [] }]),
        'particleCount',
        'This file’s particle effect "Sekai Note Tap" has more than 512 particles.',
    )
    // A tiny count over many particles: counts are whole numbers, and the particles are capped.
    await expectRefused(
        'particle',
        particleWith([
            { count: 0.005, particles: Array.from({ length: 100_000 }, () => particle) },
        ]),
        'tooManyParticles',
        'This file’s particle data has more than 32,768 particles.',
    )
    await expectRefused(
        'particle',
        particleWith([{ count: 0.5, particles: [particle] }]),
        'unreadable',
    )
    await expectRefused(
        'particle',
        particleWith([{ count: 1, particles: Array.from({ length: 513 }, () => particle) }]),
        'particleCount',
    )
    // Groups with no count are still walked.
    await expectRefused(
        'particle',
        particleWith(Array.from({ length: 200_000 }, () => ({ count: 0, particles: [] }))),
        'tooManyGroups',
        'This file’s particle data has more than 32,768 particle groups.',
    )
    await expectRefused(
        'particle',
        particleWith(Array.from({ length: 513 }, () => ({ count: 0, particles: [] }))),
        'effectGroups',
        'This file’s particle effect "Sekai Note Tap" has more than 512 particle groups.',
    )
    // Under the per-effect caps, the totals across effects still apply.
    await expectRefused(
        'particle',
        particleWith(
            Array.from({ length: 300 }, () => ({ count: 0, particles: [] })),
            120,
        ),
        'tooManyGroups',
    )
})

test('an effect name in a message is cut to 200 characters', async () => {
    const [effect] = particleData().effects
    assert.ok(effect)
    const error = await expectRefused(
        'particle',
        valid('particle', {
            resources: {
                data: gz(
                    particleData({
                        effects: [
                            {
                                ...effect,
                                name: 'N'.repeat(5000),
                                groups: [{ count: 1e6, particles: [] }],
                            },
                        ],
                    }),
                ),
            },
        }),
        'particleCount',
    )
    assert.equal(error.detail.name, 'N'.repeat(200))
})

test('a particle that names a missing sprite is refused', async () => {
    const [effect] = particleData().effects
    assert.ok(effect)
    const [group] = effect.groups
    assert.ok(group)
    const [particle] = group.particles
    assert.ok(particle)
    const broken = {
        ...effect,
        groups: [{ ...group, particles: [{ ...particle, sprite: 5 }] }],
    }
    await expectRefused(
        'particle',
        valid('particle', { resources: { data: gz(particleData({ effects: [broken] })) } }),
        'unreadable',
    )
})

test('sound effects without a usable #PERFECT are refused', async () => {
    await expectRefused(
        'effect',
        valid('effect', {
            resources: {
                data: gz(effectData({ clips: [{ name: 'Sekai Tick', filename: 'tick.mp3' }] })),
                audio: audioZip({ 'tick.mp3': wav(1) }),
            },
        }),
        'noPerfect',
        'This file’s sound effects audio has no usable #PERFECT clip.',
    )
    // The clip is there but will not decode.
    await expectRefused(
        'effect',
        valid('effect', { resources: { audio: audioZip({ 'perfect.mp3': wav(1, true) }) } }),
        'noPerfect',
    )
    // A clip the data names but the audio package lacks.
    await expectRefused(
        'effect',
        valid('effect', { resources: { audio: audioZip({ 'other.mp3': utf8('x') }) } }),
        'noPerfect',
    )
})

test('sound effects longer than 120 seconds in total are refused', async () => {
    await expectRefused(
        'effect',
        valid('effect', {
            resources: {
                data: gz(
                    effectData({
                        clips: [
                            { name: '#PERFECT', filename: 'perfect.mp3' },
                            { name: 'Sekai Tick', filename: 'tick.mp3' },
                        ],
                    }),
                ),
                audio: audioZip({
                    'perfect.mp3': wav(70),
                    'tick.mp3': wav(70),
                }),
            },
        }),
        'audioLength',
        'This file’s sound effects audio is longer than 120 seconds in total.',
    )
})

test('the audio package has its own limits', async () => {
    const clips = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`c${i}.mp3`, utf8('x')]))
    await expectRefused(
        'effect',
        valid('effect', { resources: { audio: audioZip(clips) } }),
        'unreadable',
    )
    await expectRefused(
        'effect',
        valid('effect', { resources: { audio: utf8('not a zip') } }),
        'unreadable',
    )
})

test('an item missing a resource, or its details, is refused', async () => {
    const entries = scpEntries('skin').filter((entry) => entry.data.length !== png(64, 64).length)
    // Dropping the texture's bytes leaves its SRL pointing nowhere.
    await expectRefused('skin', rawZip(entries), 'missing', 'This file’s skin texture is missing.')
    const pkg = await openSourcePackage(blobOf(valid('skin')))
    await assert.rejects(
        importItem(pkg, 'skin', 'nothing-by-this-name', context()),
        (error: unknown) => error instanceof AssetImportError && error.code === 'missing',
    )
})

test('names that climb out of the package, and too many entries, are refused', async () => {
    await expectRefused(
        'skin',
        rawZip([...scpEntries('skin'), { name: '../outside.txt', data: utf8('x') }]),
        'badName',
        'This file has an entry name that is not allowed.',
    )
    await expectRefused(
        'skin',
        rawZip([...scpEntries('skin'), { name: '/absolute.txt', data: utf8('x') }]),
        'badName',
    )
    const many = Array.from({ length: 20_001 }, (_, i) => ({
        name: `extra/${i}`,
        data: new Uint8Array(0),
        method: 0 as const,
    }))
    await expectRefused(
        'skin',
        rawZip([...scpEntries('skin'), ...many]),
        'tooManyEntries',
        'This file has more than 20,000 entries.',
    )
})

test('a file over 2 GiB is refused', async () => {
    const huge = { size: 2 * 1024 ** 3 + 1 } as Blob
    const error = await refuse('skin', huge)
    assert.equal(error.code, 'fileTooLarge')
    assert.equal(importMessage(error), 'This file is larger than 2.1 GB.')
})

test('a name that appears twice cannot be told apart, so it is refused', async () => {
    const entries = scpEntries('skin')
    const duplicate = entries.find((entry) => entry.name.startsWith('sonolus/repository/'))
    assert.ok(duplicate)
    await expectRefused(
        'skin',
        rawZip([...entries, { ...duplicate, data: utf8('different bytes') }]),
        'damaged',
    )
})

test('an item with no list or details entry of its own is found by its detail entries', async () => {
    const entries = scpEntries('skin').filter((entry) => !entry.name.endsWith('/list'))
    const pkg = await openSourcePackage(blobOf(rawZip(entries)))
    assert.deepEqual(
        (await pkg.list('skin')).map((item) => item.name),
        ['fixture'],
    )
    // And with only a list, the list's entry stands in for the details.
    const pkgList = await openSourcePackage(blobOf(valid('skin', { noDetails: true })))
    assert.equal((await importItem(pkgList, 'skin', 'fixture', context())).title, 'Fixture')
})

test('titles and authors are cut to 200 characters', async () => {
    const pkg = await openSourcePackage(
        blobOf(valid('skin', { title: 'T'.repeat(500), item: { author: 'A'.repeat(500) } })),
    )
    const record = await importItem(pkg, 'skin', 'fixture', context())
    assert.equal(record.title.length, 200)
    assert.equal(record.author.length, 200)
})

test('an aborted import stops', async () => {
    const controller = new AbortController()
    controller.abort()
    const pkg = await openSourcePackage(blobOf(valid('skin')))
    await assert.rejects(
        importItem(pkg, 'skin', 'fixture', context({ signal: controller.signal })),
        { name: 'AbortError' },
    )
})
