import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { deflateRawSync, crc32 as zlibCrc32 } from 'node:zlib'
import {
    ZipError,
    ZipReader,
    assembleZip,
    buildZip,
    crc32,
    dosFromDate,
    findAmbiguities,
    isIgnoredEntry,
    readDirectory,
    type ZipEntry,
    type ZipErrorCode,
} from '../../src/zip'
import { concat, rawZip, utf8 } from './rawZip'

const toBytes = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer())

const rejectsWith = async (promise: Promise<unknown>, code: ZipErrorCode) =>
    assert.rejects(promise, (error: unknown) => error instanceof ZipError && error.code === code)

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

test('crc32 matches the zlib CRC', () => {
    assert.equal(crc32(utf8('123456789')), 0xcbf43926)
    assert.equal(crc32(new Uint8Array(0)), 0)
    const data = new Uint8Array(100_000).map((_, i) => (i * 31) & 0xff)
    assert.equal(crc32(data), zlibCrc32(data))
    // Continuing over a split gives the whole's CRC.
    assert.equal(crc32(data.subarray(4000), crc32(data.subarray(0, 4000))), crc32(data))
})

test('round trip: STORE and DEFLATE entries, UTF-8 names, empty data', async () => {
    const big = utf8('level data '.repeat(5000))
    const binary = new Uint8Array(1000).map((_, i) => (i * 7) & 0xff)
    const blob = await buildZip([
        { name: 'project.json', method: 'deflate', data: utf8('{"format":"nxsp"}') },
        { name: 'level.json', method: 'deflate', data: big },
        { name: 'bgm/bgm.mp3', method: 'store', data: new Blob([binary]) },
        { name: 'assets/cover.png', method: 'store', data: binary },
        { name: 'empty.bin', method: 'deflate', data: new Uint8Array(0) },
        { name: 'empty-stored.bin', method: 'store', data: new Uint8Array(0) },
        { name: 'ハロー.txt', method: 'deflate', data: utf8('こんにちは') },
    ])

    const reader = await ZipReader.open(blob)
    assert.equal(reader.recovered, false)
    assert.deepEqual(
        reader.entries.map((entry) => entry.name),
        [
            'project.json',
            'level.json',
            'bgm/bgm.mp3',
            'assets/cover.png',
            'empty.bin',
            'empty-stored.bin',
            'ハロー.txt',
        ],
    )
    assert.equal(text(await reader.read(reader.get('project.json')!)), '{"format":"nxsp"}')
    assert.deepEqual(await reader.read(reader.get('level.json')!), big)
    assert.deepEqual(await reader.read(reader.get('bgm/bgm.mp3')!), binary)
    assert.deepEqual(await reader.read(reader.get('assets/cover.png')!), binary)
    assert.equal((await reader.read(reader.get('empty.bin')!)).length, 0)
    assert.equal((await reader.read(reader.get('empty-stored.bin')!)).length, 0)
    assert.equal(text(await reader.read(reader.get('ハロー.txt')!)), 'こんにちは')
    assert.equal(reader.get('level.json')!.method, 8)
    assert.equal(reader.get('bgm/bgm.mp3')!.method, 0)
    assert.ok(reader.get('level.json')!.compressedSize < big.length / 10)
    assert.equal(reader.get('LEVEL.json'), undefined)
})

test('an empty archive is the end record alone', async () => {
    const blob = await buildZip([])
    assert.equal(blob.size, 22)
    const reader = await ZipReader.open(blob)
    assert.equal(reader.entries.length, 0)
    assert.equal(reader.recovered, false)
})

test('the writer pins every header field and gives the same bytes for the same input', async () => {
    const modified = dosFromDate(new Date(Date.UTC(2026, 9, 17, 12, 34, 57)))
    assert.deepEqual(modified, {
        dosTime: (12 << 11) | (34 << 5) | 28,
        dosDate: (46 << 9) | (10 << 5) | 17,
    })
    const inputs = [
        { name: 'a.json', method: 'deflate' as const, data: utf8('{"a":1}') },
        { name: 'b.bin', method: 'store' as const, data: utf8('bytes') },
    ]
    const bytes = await toBytes(await buildZip(inputs, { modified }))
    assert.deepEqual(bytes, await toBytes(await buildZip(inputs, { modified })))

    const view = new DataView(bytes.buffer)
    // The first local header.
    assert.equal(view.getUint32(0, true), 0x04034b50)
    assert.equal(view.getUint16(4, true), 0x0014)
    assert.equal(view.getUint16(6, true), 0x0800)
    assert.equal(view.getUint16(8, true), 8)
    assert.equal(view.getUint16(10, true), modified.dosTime)
    assert.equal(view.getUint16(12, true), modified.dosDate)
    assert.equal(view.getUint32(14, true), crc32(utf8('{"a":1}')))
    assert.equal(view.getUint32(22, true), 7)
    assert.equal(view.getUint16(28, true), 0)
    // The end record: no comment, and the count, size and offset as written.
    const end = bytes.length - 22
    assert.equal(view.getUint32(end, true), 0x06054b50)
    assert.equal(view.getUint16(end + 8, true), 2)
    assert.equal(view.getUint16(end + 10, true), 2)
    assert.equal(view.getUint16(end + 20, true), 0)
    const directory = view.getUint32(end + 16, true)
    assert.equal(view.getUint32(directory, true), 0x02014b50)
    assert.equal(view.getUint16(directory + 4, true), 0x0014)
    assert.equal(view.getUint16(directory + 6, true), 0x0014)
    assert.equal(view.getUint16(directory + 8, true), 0x0800)
    // Extra, comment, disk and attribute fields are all zero.
    for (const at of [30, 32, 34, 36, 38]) assert.equal(view.getUint16(directory + at, true), 0)
    assert.equal(view.getUint32(directory + 38, true), 0)

    assert.deepEqual(dosFromDate(new Date(0)), { dosTime: 0, dosDate: 33 })
    assert.deepEqual(dosFromDate(new Date(Date.UTC(2200, 0, 1))), {
        dosTime: (23 << 11) | (59 << 5) | 29,
        dosDate: (127 << 9) | (12 << 5) | 31,
    })
})

test('the writer refuses duplicate and empty names', async () => {
    await rejectsWith(
        buildZip([
            { name: 'a', method: 'store', data: utf8('1') },
            { name: 'a', method: 'store', data: utf8('2') },
        ]),
        'limit',
    )
    await rejectsWith(buildZip([{ name: '', method: 'store', data: utf8('1') }]), 'limit')
})

test('the writer refuses to write past 4 GB or 65,535 entries, and never writes ZIP64', () => {
    // A size that leaves room for the headers is fine; the sentinel itself is refused.
    assert.doesNotThrow(() =>
        assembleZip([{ ...entry0(), size: 0xfffff000, compressedSize: 0xfffff000 }]),
    )
    assert.throws(() => assembleZip([{ ...entry0(), size: 0xffffffff, compressedSize: 0 }]), limit)
    assert.throws(() => assembleZip([{ ...entry0(), size: 0, compressedSize: 0xffffffff }]), limit)
    assert.throws(
        () => assembleZip([{ ...entry0(), size: 5 * 2 ** 30, compressedSize: 5 * 2 ** 30 }]),
        limit,
    )
    // Each entry fits, but the second one's offset or the central directory's offset does not.
    const half = { ...entry0(), size: 0x80000000, compressedSize: 0x80000000 }
    assert.throws(() => assembleZip([half, { ...half, name: 'y' }, { ...half, name: 'z' }]), limit)

    const many = Array.from({ length: 65_535 }, (_, i) => ({ ...entry0(), name: `n${i}` }))
    assert.throws(() => assembleZip(many), limit)
    assert.doesNotThrow(() => assembleZip(many.slice(1)))
})

const entry0 = () => ({
    name: 'x',
    method: 0 as const,
    crc32: 0,
    size: 0,
    compressedSize: 0,
    data: new Uint8Array(0),
})
const limit = (error: unknown) => error instanceof ZipError && error.code === 'limit'

test('reads an archive made by the operating system: DEFLATE, data descriptors, extra fields, a directory', async () => {
    // Made with Windows' tar.exe (libarchive): `tar -a -c -f os-tar.zip a.txt sub zeros.bin`.
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/os-tar.zip', import.meta.url)))
    const reader = await ZipReader.open(new Blob([bytes]))
    assert.equal(reader.recovered, false)
    assert.deepEqual(
        reader.entries.map((entry) => [entry.name, entry.method, entry.isDirectory]),
        [
            ['a.txt', 8, false],
            ['sub/', 0, true],
            ['sub/b.json', 8, false],
            ['zeros.bin', 8, false],
        ],
    )
    assert.ok(reader.entries.every((entry) => (entry.flags & 8) !== 0 || entry.isDirectory))
    assert.equal(
        text(await reader.read(reader.get('a.txt')!)),
        'hello hello hello hello hello hello\n',
    )
    assert.equal(
        text(await reader.read(reader.get('sub/b.json')!)),
        '{"k":[1,2,3,1,2,3,1,2,3,1,2,3,1,2,3]}',
    )
    assert.deepEqual(await reader.read(reader.get('zeros.bin')!), new Uint8Array(3000))
    assert.deepEqual(
        readDirectory(bytes).map((entry) => entry.name),
        ['a.txt', 'sub/', 'sub/b.json', 'zeros.bin'],
    )
})

test('reads an archive that is another tool’s: bytes after the end record, a comment holding a signature', async () => {
    const comment = concat([0x50, 0x4b, 0x05, 0x06], new Uint8Array(30), utf8('tail'))
    const archive = rawZip([{ name: 'a.txt', data: utf8('payload') }], { comment })
    const reader = await ZipReader.open(new Blob([archive]))
    assert.equal(reader.recovered, false)
    assert.equal(text(await reader.read(reader.get('a.txt')!)), 'payload')

    // Zero padding after the end record, as a tar-style block writer leaves.
    const padded = rawZip([{ name: 'a.txt', data: utf8('payload') }], {
        trailing: new Uint8Array(5000),
    })
    const second = await ZipReader.open(new Blob([padded]))
    assert.equal(second.recovered, false)
    assert.equal(text(await second.read(second.get('a.txt')!)), 'payload')
})

test('reads ZIP64 synthetically: entry fields in an extra field, and a ZIP64 end record', async () => {
    const entries = [
        { name: 'a.txt', data: utf8('first entry'), zip64: true },
        { name: 'b.bin', data: utf8('second entry'), method: 0 as const, zip64: true },
        { name: 'c.txt', data: utf8('plain entry') },
    ]
    for (const zip64End of [false, true]) {
        const archive = rawZip(entries, { zip64End })
        const reader = await ZipReader.open(new Blob([archive]))
        assert.equal(reader.recovered, false, `zip64End ${zip64End}`)
        assert.deepEqual(
            reader.entries.map((entry) => entry.size),
            [11, 12, 11],
        )
        assert.equal(text(await reader.read(reader.get('a.txt')!)), 'first entry')
        assert.equal(text(await reader.read(reader.get('b.bin')!)), 'second entry')
        assert.equal(text(await reader.read(reader.get('c.txt')!)), 'plain entry')
        assert.deepEqual(
            readDirectory(archive).map((entry) => [entry.name, entry.size, entry.localOffset]),
            reader.entries.map((entry) => [entry.name, entry.size, entry.localOffset]),
        )
    }
})

test('a ZIP64 offset past 4 GB is read as a number', () => {
    // Only the pure parser is needed: one record whose offset is a ZIP64 value past 2^32.
    const record = rawZip([{ name: 'big', data: utf8('x'), zip64: true }])
    const entries = readDirectory(record)
    assert.equal(entries[0]!.localOffset, 0)
    const view = new DataView(record.buffer)
    const directory = view.getUint32(record.length - 6, true)
    // Past the 46-byte record and the name, the extra field holds size, compressed size and offset.
    view.setBigUint64(directory + 46 + 3 + 4 + 16, 5n * 2n ** 32n, true)
    assert.equal(readDirectory(record)[0]!.localOffset, 5 * 2 ** 32)
})

test('a missing central directory falls back to a sequential scan', async () => {
    const blob = await buildZip([
        { name: 'one.json', method: 'deflate', data: utf8('{"n":1}'.repeat(50)) },
        { name: 'two.bin', method: 'store', data: utf8('two') },
        { name: 'three.json', method: 'deflate', data: utf8('{"n":3}'.repeat(50)) },
    ])
    const bytes = await toBytes(blob)
    const directory = new DataView(bytes.buffer).getUint32(bytes.length - 6, true)

    // The directory and end record cut off whole.
    const cut = await ZipReader.open(new Blob([bytes.subarray(0, directory)]))
    assert.equal(cut.recovered, true)
    assert.deepEqual(
        cut.entries.map((entry) => entry.name),
        ['one.json', 'two.bin', 'three.json'],
    )
    assert.equal(text(await cut.read(cut.get('two.bin')!)), 'two')

    // The end record's signature damaged.
    const damaged = bytes.slice()
    damaged[bytes.length - 22] = 0
    const second = await ZipReader.open(new Blob([damaged]))
    assert.equal(second.recovered, true)
    assert.equal(second.entries.length, 3)
})

test('truncated-file recovery: the entries wholly present are kept', async () => {
    const one = utf8('{"n":1}'.repeat(200))
    const blob = await buildZip([
        { name: 'project.json', method: 'deflate', data: one },
        { name: 'level.json', method: 'deflate', data: utf8('{"n":2}'.repeat(200)) },
        {
            name: 'history/chunks.bin',
            method: 'store',
            data: new Uint8Array(5000).map((_, i) => i & 0xff),
        },
    ])
    const bytes = await toBytes(blob)
    const reader = await ZipReader.open(blob)
    const third = reader.get('history/chunks.bin')!

    // Cut in the middle of the last entry's data.
    const cut = await ZipReader.open(
        new Blob([bytes.subarray(0, third.localOffset + 30 + 18 + 2000)]),
    )
    assert.equal(cut.recovered, true)
    assert.deepEqual(
        cut.entries.map((entry) => entry.name),
        ['project.json', 'level.json'],
    )
    assert.deepEqual(await cut.read(cut.get('project.json')!), one)

    // Cut in the middle of a header.
    const early = await ZipReader.open(new Blob([bytes.subarray(0, third.localOffset + 10)]))
    assert.equal(early.entries.length, 2)

    // Cut in the first entry: nothing wholly present.
    await rejectsWith(ZipReader.open(new Blob([bytes.subarray(0, 40)])), 'truncated')
    // Not a ZIP at all.
    await rejectsWith(ZipReader.open(new Blob([utf8('{"entities":[]}')])), 'not-zip')
    await rejectsWith(ZipReader.open(new Blob([])), 'not-zip')
})

test('a deflated entry with a data descriptor stops a scan, but earlier entries stay', async () => {
    const archive = rawZip([
        { name: 'a.txt', data: utf8('kept') },
        { name: 'b.txt', data: utf8('streamed'), flags: 0x0808 },
    ])
    // Zero the local header's sizes, as a streaming writer does, and cut the directory off.
    const view = new DataView(archive.buffer)
    const second = 30 + 5 + 4 + deflateRawSync(utf8('kept')).length
    view.setUint32(second + 14, 0, true)
    view.setUint32(second + 18, 0, true)
    view.setUint32(second + 22, 0, true)
    const directory = view.getUint32(archive.length - 6, true)
    const reader = await ZipReader.open(new Blob([archive.subarray(0, directory)]))
    assert.equal(reader.recovered, true)
    assert.deepEqual(
        reader.entries.map((entry) => entry.name),
        ['a.txt'],
    )
})

test('every read verifies the CRC and the declared size', async () => {
    const data = utf8('checked '.repeat(100))
    const other = utf8('differs '.repeat(100))
    const reader = await ZipReader.open(
        new Blob([
            rawZip([
                { name: 'good', data },
                { name: 'bad-store', data, method: 0, stored: other },
                { name: 'bad-deflate', data, stored: deflateRawSync(other) },
                { name: 'short', data, stored: deflateRawSync(utf8('checked')) },
                { name: 'directory-crc', data, central: { crc32: 1 } },
            ]),
        ]),
    )
    assert.deepEqual(await reader.read(reader.get('good')!), data)
    await rejectsWith(reader.read(reader.get('bad-store')!), 'crc')
    await rejectsWith(reader.read(reader.get('bad-deflate')!), 'crc')
    await rejectsWith(reader.read(reader.get('short')!), 'size')
    // The local header's CRC disagrees with the directory's.
    await rejectsWith(reader.read(reader.get('directory-crc')!), 'header')
})

test('inflating past the declared size is damage, and caps refuse before reading', async () => {
    const bomb = new Uint8Array(1_000_000)
    const archive = rawZip([
        { name: 'bomb', data: bomb, central: { size: 100 } },
        { name: 'short', data: utf8('0123456789'), central: { size: 20 } },
        { name: 'ok', data: bomb },
    ])
    const reader = await ZipReader.open(new Blob([archive]))
    // The local header's size differs from the directory's: damage either way.
    await rejectsWith(reader.read(reader.get('bomb')!), 'header')
    await rejectsWith(reader.read(reader.get('short')!), 'header')

    // With the directory and header agreeing on a size the data does not match.
    const agreeing = rawZip([{ name: 'bomb', data: bomb }])
    const view = new DataView(agreeing.buffer)
    const directory = view.getUint32(agreeing.length - 6, true)
    view.setUint32(22, 100, true)
    view.setUint32(directory + 24, 100, true)
    const second = await ZipReader.open(new Blob([agreeing]))
    await rejectsWith(second.read(second.get('bomb')!), 'size')

    await rejectsWith(reader.read(reader.get('ok')!, { maxSize: 999_999 }), 'too-large')
    assert.equal((await reader.read(reader.get('ok')!, { maxSize: 1_000_000 })).length, 1_000_000)
})

test('a stream with bytes after its end is damage', async () => {
    const data = utf8('abc')
    const stored = concat(deflateRawSync(data), [9, 9])
    const archive = rawZip([{ name: 'trailing', data, stored }])
    // Make the local header and directory agree on the longer stored size.
    const view = new DataView(archive.buffer)
    const directory = view.getUint32(archive.length - 6, true)
    view.setUint32(18, stored.length, true)
    view.setUint32(directory + 20, stored.length, true)
    const reader = await ZipReader.open(new Blob([archive]))
    await rejectsWith(reader.read(reader.get('trailing')!), 'size')
})

test('duplicate names and overlapping data make a name ambiguous', async () => {
    const archive = rawZip([
        { name: 'dup', data: utf8('1') },
        { name: 'dup', data: utf8('2') },
        { name: 'fine', data: utf8('3') },
    ])
    const reader = await ZipReader.open(new Blob([archive]))
    assert.deepEqual(reader.duplicates, ['dup'])
    assert.equal(reader.get('dup'), undefined)
    assert.equal(text(await reader.read(reader.get('fine')!)), '3')
    assert.equal(reader.entries.length, 3)

    // Names that differ only by Unicode normalisation are the same name.
    const nfd = rawZip([
        { name: 'é.txt', data: utf8('1') },
        { name: 'é.txt', data: utf8('2') },
    ])
    const second = await ZipReader.open(new Blob([nfd]))
    assert.equal(second.duplicates.length, 1)
    assert.equal(second.get('é.txt'), undefined)

    const first = readDirectory(rawZip([{ name: 'a', data: utf8('x'.repeat(100)), method: 0 }]))[0]!
    const overlapping: ZipEntry[] = [
        first,
        { ...first, index: 1, name: 'b', key: 'b', localOffset: 40 },
    ]
    assert.deepEqual(findAmbiguities(overlapping).overlapping.sort(), ['a', 'b'])
})

test('a local header that disagrees with the directory is damage', async () => {
    const data = utf8('hello')
    const archive = rawZip([{ name: 'a', data, method: 0 }])
    const view = new DataView(archive.buffer)
    view.setUint32(14, 123, true) // the local CRC
    const reader = await ZipReader.open(new Blob([archive]))
    await rejectsWith(reader.read(reader.get('a')!), 'header')

    const renamed = rawZip([{ name: 'a', data, method: 0 }])
    renamed[30] = 'b'.charCodeAt(0)
    const second = await ZipReader.open(new Blob([renamed]))
    await rejectsWith(second.read(second.get('a')!), 'header')
})

test('unsupported methods and encrypted entries are refused', async () => {
    const reader = await ZipReader.open(
        new Blob([
            rawZip([
                { name: 'bzip', data: utf8('x'), method: 0, central: { method: 12 } },
                { name: 'secret', data: utf8('x'), method: 0, flags: 0x0801 },
            ]),
        ]),
    )
    await rejectsWith(reader.read(reader.get('bzip')!), 'unsupported')
    await rejectsWith(reader.read(reader.get('secret')!), 'unsupported')
})

test('names: the UTF-8 flag, UTF-8 without it, and CP437', async () => {
    const reader = await ZipReader.open(
        new Blob([
            rawZip([
                { name: 'flagged-é', data: utf8('1') },
                { name: utf8('unflagged-é'), data: utf8('2'), flags: 0 },
                { name: new Uint8Array([0x63, 0x61, 0x66, 0x82]), data: utf8('3'), flags: 0 },
            ]),
        ]),
    )
    assert.deepEqual(
        reader.entries.map((entry) => entry.name),
        ['flagged-é', 'unflagged-é', 'café'],
    )
})

test('ignored entries', () => {
    const ignored = (name: string) => isIgnoredEntry({ key: name, isDirectory: name.endsWith('/') })
    for (const name of [
        'dir/',
        '__MACOSX/._a',
        'cache/x.json',
        '.DS_Store',
        'sub/.DS_Store',
        'Thumbs.db',
        'a/desktop.ini',
        'a/._b',
    ]) {
        assert.ok(ignored(name), name)
    }
    for (const name of ['project.json', 'level.json', 'sub/cache/x', 'a._b', 'bgm/bgm.mp3']) {
        assert.ok(!ignored(name), name)
    }
})

test('the central-directory parser reads what scp.ts needs, without verifying CRCs', () => {
    // Like the preview fixture: STORE, flags 0, CRC fields zero.
    const archive = rawZip([
        {
            name: 'sonolus/skins/list',
            data: utf8('{"items":[]}'),
            method: 0,
            flags: 0,
            central: { crc32: 0 },
        },
        { name: 'data', data: utf8('payload'), method: 0, flags: 0, central: { crc32: 0 } },
    ])
    const entries = readDirectory(archive)
    assert.deepEqual(
        entries.map((entry) => [entry.name, entry.method, entry.compressedSize]),
        [
            ['sonolus/skins/list', 0, 12],
            ['data', 0, 7],
        ],
    )
})

test('the parser reads the shipped packages', { skip: !hasShippedPackages() }, () => {
    for (const name of ['skin', 'particle']) {
        const bytes = new Uint8Array(readFileSync(`public/resource/${name}.scp`))
        const entries = readDirectory(bytes)
        assert.deepEqual(entries.map((entry) => entry.name).slice(2), ['data', 'texture'])
        assert.ok(entries.every((entry) => entry.method === 0))
    }
})

function hasShippedPackages() {
    try {
        readFileSync('public/resource/skin.scp')
        return true
    } catch {
        return false
    }
}
