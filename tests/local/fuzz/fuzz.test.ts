import fc from 'fast-check'
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
import { widen } from '../timeline/helpers'

// Fuzzing the readers of untrusted bytes that feed the damage paths (Part 1 §1.11.6;
// r12-arch-core M6), with fast-check: mutated inputs must give a result (damage, unreadable,
// partial), never an uncaught throw or a hang, and a failure shrinks to its fewest mutations.
// `npm test` runs a short pass; NSE_FUZZ=<runs> runs longer, NSE_FUZZ_SEED=<s> replays a seed.

const iterations = Number(process.env.NSE_FUZZ ?? 60)
const seed = process.env.NSE_FUZZ_SEED
const golden = join(import.meta.dirname, '..', 'nxsp', 'golden-v1')
const seeds = ['write-1.nxsp', 'write-2.nxsp'].map(
    (name) => new Uint8Array(readFileSync(join(golden, name))),
)

const options = (runs: number) => ({ numRuns: runs, ...(seed ? { seed: Number(seed) } : {}) })

/** One mutation: a byte set, a cut, a range repeated, or a small number in a 4-byte field. */
type Mutation = { kind: number; at: number; from: number; length: number; value: number }

const mutation: fc.Arbitrary<Mutation> = fc.record({
    kind: fc.nat({ max: 4 }),
    at: fc.nat(),
    from: fc.nat(),
    length: fc.nat({ max: 63 }),
    value: fc.nat(),
})

const mutations = fc.array(mutation, { minLength: 1, maxLength: 4 })

const mutate = (input: Uint8Array, list: readonly Mutation[]): Uint8Array<ArrayBuffer> => {
    let bytes = new Uint8Array(input)
    for (const { kind, at: rawAt, from: rawFrom, length, value } of list) {
        const at = rawAt % (bytes.length || 1)
        switch (kind) {
            case 0:
            case 1:
                bytes[at] = value & 0xff
                break
            case 2:
                bytes = bytes.slice(0, at)
                break
            case 3: {
                const from = rawFrom % (bytes.length || 1)
                const piece = bytes.slice(from, from + length)
                bytes = Uint8Array.from([...bytes.subarray(0, at), ...piece, ...bytes.subarray(at)])
                break
            }
            default: {
                // Small numbers in little-endian fields: sizes and offsets gone wrong.
                const field = [0, 1, 0xffff, 0xffffffff, value % (1 << 20)][value % 5] ?? 0
                for (let i = 0; i < 4 && at + i < bytes.length; i++)
                    bytes[at + i] = (field >>> (8 * i)) & 0xff
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
    await fc.assert(
        fc.asyncProperty(fc.nat({ max: seeds.length - 1 }), mutations, async (which, list) => {
            const bytes = mutate(seeds[which] ?? new Uint8Array(), list)
            await settles('the .nxsp reader', async () => {
                const read = await readNxsp(new Blob([bytes]))
                if (read.kind === 'nxsp' && read.history) {
                    // A lazily read chunk fails as damage, never as a crash.
                    for (const hash of [...read.history.index.keys()].slice(0, 3))
                        await read.history.chunks.read(hash).catch((error: unknown) => {
                            assert.ok(error instanceof Error)
                        })
                }
            })
        }),
        options(iterations),
    )
})

test('the ZIP reader rejects or reads every mutated archive, by its own errors', async () => {
    await fc.assert(
        fc.asyncProperty(mutations, async (list) => {
            const bytes = mutate(seeds[0] ?? new Uint8Array(), list)
            try {
                const reader = await ZipReader.open(new Blob([bytes]))
                for (const entry of reader.entries)
                    await reader.read(entry, { maxSize: 1 << 24 }).catch((error: unknown) => {
                        assert.ok(error instanceof Error, String(error))
                    })
            } catch (error) {
                assert.ok(error instanceof Error, String(error))
            }
        }),
        options(iterations),
    )
})

test('the manifest parser reports every mutated part, never throwing', () => {
    const base: unknown = {
        version: 1,
        entries: [{ kind: 'init', time: 1, label: 'x', snapshot: '0'.repeat(32), noteCount: 0 }],
        roots: {},
        nodes: {},
        chunks: [],
        undoStack: { base: 0, slots: [{ snapshot: '0'.repeat(32), label: 'x' }], index: 0 },
    }
    const values: unknown[] = [null, -1, 1.5, '', 'x', [], {}, true, 2 ** 53, '0'.repeat(32)]
    /** The base with values replaced and keys renamed, as `choices` decide in turn. */
    const twisted = (choices: readonly number[]) => {
        let at = 0
        const next = (n: number) => (choices[at++ % choices.length] ?? 0) % n
        const twist = (value: unknown, depth: number): unknown => {
            if (depth > 4 || next(4) === 3) return values[next(values.length)]
            if (Array.isArray(value)) return value.map((item) => twist(item, depth + 1))
            if (typeof value === 'object' && value !== null)
                return Object.fromEntries(
                    Object.entries(value).map(([key, item]) => [
                        next(9) === 8 ? `${key}x` : key,
                        twist(item, depth + 1),
                    ]),
                )
            return next(2) ? values[next(values.length)] : value
        }
        return twist(base, 0)
    }
    fc.assert(
        fc.property(fc.array(fc.nat(), { minLength: 1, maxLength: 128 }), (choices) => {
            const result = checkPart(twisted(choices), 'manifest', true)
            assert.ok(result.part !== undefined || result.issues.length > 0)
        }),
        options(iterations * 10),
    )
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
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    fc.assert(
        fc.property(mutations, (list) => {
            const mutated = decoder.decode(mutate(encoder.encode(text), list))
            try {
                const reading = readJournal(mutated, session.id)
                assert.ok(['journal', 'later', 'unreadable'].includes(reading.kind))
            } catch (error) {
                assert.fail(String(error))
            }
        }),
        options(iterations * 5),
    )
})
