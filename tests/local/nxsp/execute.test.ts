import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'
import {
    executePlan,
    ExecutionError,
    inspectNxsp,
    type PlannedEntry,
    type PlanPart,
    type SourceEntry,
    type WritePlan,
} from '../../../src/local/nxsp'
import { crc32, ZipReader } from '../../../src/zip'
import { rawZip, type RawEntry } from '../../zip/rawZip'
import { blobBytes, memorySource, utf8 } from './helpers'

const MODIFIED = { dosTime: 0, dosDate: 33 }
const STORED = utf8('stored bytes, copied as they are')
const DEFLATED = utf8('deflated bytes '.repeat(20))

const sourceZip = (extra: RawEntry[] = []) =>
    rawZip([
        { name: 'project.json', data: utf8('{}') },
        { name: 'a.bin', data: STORED, method: 0 },
        { name: 'b.json', data: DEFLATED, method: 8 },
        ...extra,
    ])

const pinned = async (bytes: Uint8Array) =>
    inspectNxsp(new Blob([new Uint8Array(bytes)]), { token: 's', role: 'target', fingerprint: 'f' })

const copy = (entry: SourceEntry, inflate = false): PlanPart => ({
    kind: 'copy',
    source: 's',
    entryIndex: entry.index,
    dataOffset: entry.dataOffset,
    ...(inflate ? { inflate: true as const } : {}),
    check: { kind: 'entryCrc' },
})

const run = (entries: PlannedEntry[], bytes: Uint8Array, source = memorySource(bytes, 'f')) =>
    executePlan({ modified: MODIFIED, entries } satisfies WritePlan, new Map([['s', source]]))

const fails = async (promise: Promise<unknown>, code: string, pattern?: RegExp) => {
    await assert.rejects(promise, (error: unknown) => {
        assert.ok(error instanceof ExecutionError, String(error))
        assert.equal(error.code, code, error.message)
        if (pattern) assert.match(error.message, pattern)
        return true
    })
}

const entryOf = (source: Awaited<ReturnType<typeof pinned>>, name: string) => {
    const found = source.entries.find((e) => e.name === name)
    assert.ok(found)
    return found
}

test('copies: as stored, keeping the method, or inflated into a STORE entry; CRCs and sizes computed', async () => {
    const bytes = sourceZip()
    const source = await pinned(bytes)
    const a = entryOf(source, 'a.bin')
    const b = entryOf(source, 'b.json')
    const extraBytes = utf8(' and more')
    const file = await run(
        [
            { name: 'a.bin', method: 0, parts: [copy(a), { kind: 'bytes', data: extraBytes }] },
            {
                name: 'b.json',
                method: 8,
                crc32: b.crc32,
                uncompressedSize: b.uncompressedSize,
                parts: [copy(b)],
            },
            {
                name: 'c.bin',
                method: 0,
                crc32: b.crc32,
                uncompressedSize: b.uncompressedSize,
                parts: [copy(b, true)],
            },
        ],
        bytes,
    )
    const reader = await ZipReader.open(file)
    const read = async (name: string) => {
        const entry = reader.get(name)
        assert.ok(entry)
        return reader.read(entry, { maxSize: 1 << 20 })
    }
    assert.deepEqual(await read('a.bin'), new Uint8Array([...STORED, ...extraBytes]))
    assert.deepEqual(await read('b.json'), DEFLATED)
    assert.deepEqual(await read('c.bin'), DEFLATED)
    assert.equal(reader.get('b.json')?.method, 8)
    assert.equal(reader.get('c.bin')?.method, 0)
    // The deflated copy is byte for byte the source's stored data.
    const out = await blobBytes(file)
    const stored = new Uint8Array(deflateRawSync(DEFLATED))
    assert.ok(Buffer.from(out).includes(Buffer.from(stored)))
})

test('plan errors: a method-8 entry without its CRC and size, of two parts, or from an inflate copy', async () => {
    const bytes = sourceZip()
    const source = await pinned(bytes)
    const b = entryOf(source, 'b.json')
    const data = new Uint8Array(deflateRawSync(DEFLATED))
    await fails(run([{ name: 'x', method: 8, parts: [{ kind: 'bytes', data }] }], bytes), 'plan')
    await fails(
        run(
            [
                {
                    name: 'x',
                    method: 8,
                    crc32: crc32(DEFLATED),
                    uncompressedSize: DEFLATED.length * 2,
                    parts: [
                        { kind: 'bytes', data },
                        { kind: 'bytes', data },
                    ],
                },
            ],
            bytes,
        ),
        'plan',
    )
    await fails(
        run(
            [
                {
                    name: 'x',
                    method: 8,
                    crc32: b.crc32,
                    uncompressedSize: b.uncompressedSize,
                    parts: [copy(b, true)],
                },
            ],
            bytes,
        ),
        'plan',
    )
})

test('plan errors: a wrong CRC or size, a method mismatch, a dataOffset the entry does not have, an unknown source', async () => {
    const bytes = sourceZip()
    const source = await pinned(bytes)
    const a = entryOf(source, 'a.bin')
    const b = entryOf(source, 'b.json')
    await fails(
        run([{ name: 'x', method: 0, crc32: a.crc32 ^ 1, parts: [copy(a)] }], bytes),
        'plan',
        /CRC/,
    )
    await fails(
        run([{ name: 'x', method: 0, uncompressedSize: 1, parts: [copy(a)] }], bytes),
        'plan',
        /size/,
    )
    await fails(run([{ name: 'x', method: 0, parts: [copy(b)] }], bytes), 'plan', /method/)
    await fails(
        run(
            [
                {
                    name: 'x',
                    method: 0,
                    parts: [{ ...copy(a), dataOffset: a.dataOffset + 1 } as PlanPart],
                },
            ],
            bytes,
        ),
        'plan',
        /start/,
    )
    await fails(
        run([{ name: 'x', method: 0, parts: [{ ...copy(a), source: 'nope' } as PlanPart] }], bytes),
        'plan',
    )
    const bad = new Uint8Array(deflateRawSync(DEFLATED))
    await fails(
        run(
            [
                {
                    name: 'x',
                    method: 8,
                    crc32: crc32(DEFLATED),
                    uncompressedSize: DEFLATED.length - 1,
                    parts: [{ kind: 'bytes', data: bad }],
                },
            ],
            bytes,
        ),
        'plan',
    )
})

test('65,535 entries is a plan error', async () => {
    const entries: PlannedEntry[] = Array.from({ length: 65535 }, (_, i) => ({
        name: `e${i}`,
        method: 0,
        parts: [],
    }))
    await fails(executePlan({ modified: MODIFIED, entries }, new Map()), 'plan')
})

test('a copy whose CRC fails is damage in its source, named with its role; with the fingerprint changed, a conflict', async () => {
    // d.bin's bytes flipped, the CRC both headers record kept.
    const bytes = sourceZip([
        { name: 'd.bin', data: STORED, method: 0, stored: STORED.map((byte) => byte ^ 1) },
    ])
    const source = await pinned(bytes)
    const d = entryOf(source, 'd.bin')
    await assert.rejects(
        run([{ name: 'x', method: 0, parts: [copy(d)] }], bytes),
        (error: unknown) => {
            assert.ok(error instanceof ExecutionError)
            assert.equal(error.code, 'io')
            assert.deepEqual(error.source, { token: 's', role: 'target' })
            return true
        },
    )
    const changed = memorySource(bytes, 'f')
    changed.changed = true
    await fails(run([{ name: 'x', method: 0, parts: [copy(d)] }], bytes, changed), 'conflict')
})

test('a source whose bytes changed after inspect is a conflict, whatever source check fails first', async () => {
    const bytes = sourceZip()
    const source = await pinned(bytes)
    const a = entryOf(source, 'a.bin')
    const b = entryOf(source, 'b.json')
    // Rewritten: a longer project.json moves every entry; a.bin's content and CRC changed.
    const later = rawZip([
        { name: 'project.json', data: utf8('{"longer":true}') },
        { name: 'a.bin', data: utf8('other bytes'), method: 0 },
        { name: 'b.json', data: DEFLATED, method: 0 },
    ])
    const plans: PlannedEntry[][] = [
        // A dataOffset the entry no longer has.
        [{ name: 'x', method: 0, parts: [copy(a)] }],
        // A method the entry no longer has.
        [
            {
                name: 'x',
                method: 8,
                crc32: b.crc32,
                uncompressedSize: b.uncompressedSize,
                parts: [{ ...copy(b), dataOffset: b.dataOffset + 13 }],
            },
        ],
        // An entry index past the directory.
        [{ name: 'x', method: 0, parts: [{ ...copy(a), entryIndex: 9 }] }],
    ]
    for (const entries of plans) {
        const changed = memorySource(later, 'f')
        changed.changed = true
        await fails(run(entries, later, changed), 'conflict')
        // The same checks with the fingerprint unchanged are plan errors.
        await fails(run(entries, later), 'plan')
    }
    // The content and its CRC changed together, the offsets kept: the planned CRC differs.
    const same = rawZip([
        { name: 'project.json', data: utf8('{}') },
        { name: 'a.bin', data: STORED.map((byte) => byte ^ 1), method: 0 },
        { name: 'b.json', data: DEFLATED, method: 8 },
    ])
    const planned: PlannedEntry = {
        name: 'x',
        method: 0,
        crc32: a.crc32,
        uncompressedSize: a.uncompressedSize,
        parts: [copy(a)],
    }
    const changed = memorySource(same, 'f')
    changed.changed = true
    await fails(run([planned], same, changed), 'conflict')
    await fails(run([planned], same), 'plan', /planned CRC differs/)
})

test('an inflate copy of a STORE entry is a plan error', async () => {
    const bytes = sourceZip()
    const a = entryOf(await pinned(bytes), 'a.bin')
    await fails(run([{ name: 'x', method: 0, parts: [copy(a, true)] }], bytes), 'plan', /STORE/)
})

test('a source that changed after its last copy is a conflict, even when every copy passed', async () => {
    const bytes = sourceZip()
    const source = await pinned(bytes)
    const a = entryOf(source, 'a.bin')
    const changing = memorySource(bytes, 'f')
    changing.readFingerprint = async () => 'f:later'
    await fails(run([{ name: 'x', method: 0, parts: [copy(a)] }], bytes, changing), 'conflict')
})

test('an inflate copy of a bomb, a truncated stream or trailing bytes is damage in the source', async () => {
    const big = utf8('x'.repeat(10_000))
    for (const stored of [
        new Uint8Array(deflateRawSync(big)),
        new Uint8Array(deflateRawSync(big)).subarray(0, 20),
        new Uint8Array([...deflateRawSync(big), 0]),
    ]) {
        // Declares 100 bytes, whatever the stream holds.
        const bytes = sourceZip([
            { name: 'bomb.bin', data: big.subarray(0, 100), method: 8, stored },
        ])
        const source = await pinned(bytes)
        const bomb = entryOf(source, 'bomb.bin')
        await fails(run([{ name: 'x', method: 0, parts: [copy(bomb, true)] }], bytes), 'io')
    }
})

test('a source with data descriptors and local extra fields copies by its local header', async () => {
    const bytes = rawZip([
        { name: 'project.json', data: utf8('{}'), flags: 0x0808 },
        { name: 'z.bin', data: STORED, method: 0, zip64: true },
    ])
    const source = await pinned(bytes)
    const z = entryOf(source, 'z.bin')
    assert.ok(z.dataOffset > 30 + 'z.bin'.length, 'the local extra field is counted')
    const file = await run(
        [
            {
                name: 'z.bin',
                method: 0,
                crc32: z.crc32,
                uncompressedSize: z.uncompressedSize,
                parts: [copy(z)],
            },
        ],
        bytes,
    )
    const reader = await ZipReader.open(file)
    const entry = reader.get('z.bin')
    assert.ok(entry)
    assert.deepEqual(await reader.read(entry, { maxSize: 1000 }), STORED)
})
