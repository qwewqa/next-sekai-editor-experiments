import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { readJournal } from '../../../src/local/journal/format'
import { checkPart } from '../../../src/local/nxsp/manifest'
import { readNxsp } from '../../../src/local/nxsp/read'
import { createWorld } from '../../../src/local/testing/world'
import { ZipReader } from '../../../src/zip/reader'
import { append, beginSession, openJournalPage } from '../journal/harness'
import { goldenChart, stateOf } from '../records/charts'
import { random, type Random } from '../save/random'
import { widen } from '../timeline/helpers'

// Fuzzing the readers of untrusted bytes that feed the damage paths (Part 1 §1.11.6;
// r12-arch-core M6): the ZIP reader, the manifest parser (through the `.nxsp` reader) and the
// journal parser. Mutated inputs must give a result (damage, unreadable, partial), never an
// uncaught throw or a hang. `npm test` runs a short pass; NSE_FUZZ=<iterations> runs longer.

const iterations = Number(process.env.NSE_FUZZ ?? 60)
const golden = join(import.meta.dirname, '..', 'nxsp', 'golden-v1')
const seeds = ['write-1.nxsp', 'write-2.nxsp'].map(
    (name) => new Uint8Array(readFileSync(join(golden, name))),
)

/** One mutation: flipped bytes, a cut, a repeated range, or bytes spliced in. */
const mutate = (input: Uint8Array, rng: Random): Uint8Array<ArrayBuffer> => {
    let bytes = new Uint8Array(input)
    for (let n = 1 + rng.int(4); n > 0; n--) {
        const at = rng.int(bytes.length || 1)
        switch (rng.int(5)) {
            case 0:
            case 1:
                bytes[at] = rng.int(256)
                break
            case 2:
                bytes = bytes.slice(0, at)
                break
            case 3: {
                const from = rng.int(bytes.length || 1)
                const piece = bytes.slice(from, from + rng.int(64))
                bytes = Uint8Array.from([...bytes.subarray(0, at), ...piece, ...bytes.subarray(at)])
                break
            }
            default: {
                // Small numbers in little-endian fields: sizes and offsets gone wrong.
                const value = [0, 1, 0xffff, 0xffffffff, rng.int(1 << 20)][rng.int(5)] ?? 0
                for (let i = 0; i < 4 && at + i < bytes.length; i++)
                    bytes[at + i] = (value >>> (8 * i)) & 0xff
            }
        }
    }
    return bytes
}

/** Fails on a throw a reader must never make: anything it reports is fine. */
const settles = async (label: string, run: () => Promise<unknown>) => {
    try {
        await run()
    } catch (error) {
        assert.fail(
            `${label}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
        )
    }
}

test('the .nxsp reader reports every mutated file, never throwing', async () => {
    const rng = random(Number(process.env.NSE_FUZZ_SEED ?? 1))
    for (let i = 0; i < iterations; i++) {
        const seed = seeds[rng.int(seeds.length)]
        assert.ok(seed)
        const bytes = mutate(seed, rng)
        await settles(`iteration ${i}`, async () => {
            const read = await readNxsp(new Blob([bytes]))
            if (read.kind === 'nxsp' && read.history) {
                // A lazily read chunk fails as damage, never as a crash.
                for (const hash of [...read.history.index.keys()].slice(0, 3))
                    await read.history.chunks.read(hash).catch((error: unknown) => {
                        assert.ok(error instanceof Error)
                    })
            }
        })
    }
})

test('the ZIP reader rejects or reads every mutated archive, by its own errors', async () => {
    const rng = random(Number(process.env.NSE_FUZZ_SEED ?? 2))
    for (let i = 0; i < iterations; i++) {
        const bytes = mutate(seeds[0] ?? new Uint8Array(), rng)
        try {
            const reader = await ZipReader.open(new Blob([bytes]))
            for (const entry of reader.entries)
                await reader.read(entry, { maxSize: 1 << 24 }).catch((error: unknown) => {
                    assert.ok(error instanceof Error, String(error))
                })
        } catch (error) {
            assert.ok(error instanceof Error, String(error))
        }
    }
})

test('the manifest parser reports every mutated part, never throwing', () => {
    const rng = random(Number(process.env.NSE_FUZZ_SEED ?? 3))
    const base: unknown = {
        version: 1,
        entries: [{ kind: 'init', time: 1, label: 'x', snapshot: '0'.repeat(32), noteCount: 0 }],
        roots: {},
        nodes: {},
        chunks: [],
        undoStack: { base: 0, slots: [{ snapshot: '0'.repeat(32), label: 'x' }], index: 0 },
    }
    const values: unknown[] = [null, -1, 1.5, '', 'x', [], {}, true, 2 ** 53, '0'.repeat(32)]
    const twist = (value: unknown, depth: number): unknown => {
        if (depth > 4 || rng.int(4) === 0) return values[rng.int(values.length)]
        if (Array.isArray(value)) return value.map((item) => twist(item, depth + 1))
        if (typeof value === 'object' && value !== null)
            return Object.fromEntries(
                Object.entries(value).map(([key, item]) => [
                    rng.int(9) ? key : `${key}x`,
                    twist(item, depth + 1),
                ]),
            )
        return rng.int(2) ? value : values[rng.int(values.length)]
    }
    for (let i = 0; i < iterations * 10; i++) {
        const part = twist(base, 0)
        const result = checkPart(part, 'manifest', true)
        assert.ok(result.part !== undefined || result.issues.length > 0)
    }
})

test('the journal parser reads or refuses every mutated journal, never throwing', async () => {
    const world = createWorld({ seed: 4 })
    const page = await openJournalPage(world, 'a')
    const a = stateOf(goldenChart())
    const session = beginSession(page, a)
    append(page, 'edit', 'Changed note', widen(a))
    assert.equal(page.writer.write(), true)
    const text = page.storage.getItem(`nse.journal.${session.id}`)
    assert.ok(text)
    const rng = random(Number(process.env.NSE_FUZZ_SEED ?? 5))
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    for (let i = 0; i < iterations * 5; i++) {
        const mutated = decoder.decode(mutate(encoder.encode(text), rng))
        try {
            const reading = readJournal(mutated, session.id)
            assert.ok(['journal', 'later', 'unreadable'].includes(reading.kind))
        } catch (error) {
            assert.fail(`iteration ${i}: ${String(error)}`)
        }
    }
})
