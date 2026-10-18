import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'
import {
    executePlan,
    ExecutionError,
    inspectNxsp,
    planNxsp,
    type PinnedSource,
    type PlannedEntry,
    type WritePlan,
} from '../../src/local/nxsp'
import { crc32, zipFingerprint, ZipReader } from '../../src/zip'
import {
    chain,
    firstInput,
    fixedChunks,
    root as goldenRoot,
    secondInput,
} from '../local/nxsp/goldenChain'

// The plan conformance set (§1.6.11.7), frozen with v1: the same plan gives the same bytes on every
// platform. Each case in `plan-conformance-v1/<case>/` holds `plan.json` (bytes parts as
// `{ "$u8": "<base64>" }`, copy parts naming a source file in the case), the sources, `pinned.json`
// (each source's inspect result and its fingerprint, a literal), and `expected.nxsp` or
// `expected-error.json`; `hook.json`'s `change` names a source whose fingerprint changes after
// inspect. The web executor (here) and Rust (`cargo test`) must both pass every case, and every
// `expected.nxsp` passes `tools/nxsp_check.py`. `NSE_WRITE_GOLDEN=1` writes the set, once.

const root = join(import.meta.dirname, 'plan-conformance-v1')
const writing = process.env.NSE_WRITE_GOLDEN === '1'

type Json = Record<string, unknown>

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

const planToJson = (plan: WritePlan): Json => ({
    modified: plan.modified,
    entries: plan.entries.map((entry) => ({
        ...entry,
        parts: entry.parts.map((part) =>
            part.kind === 'bytes' ? { kind: 'bytes', data: { $u8: b64(part.data) } } : part,
        ),
    })),
})

const planFromJson = (json: Json): WritePlan => {
    const plan = json as unknown as WritePlan
    return {
        modified: plan.modified,
        entries: plan.entries.map((entry) => ({
            ...entry,
            parts: entry.parts.map((part) =>
                part.kind === 'bytes'
                    ? {
                          kind: 'bytes',
                          data: new Uint8Array(
                              Buffer.from((part.data as unknown as { $u8: string }).$u8, 'base64'),
                          ),
                      }
                    : part,
            ),
        })),
    }
}

// A raw ZIP writer for the awkward sources an OS or another tool writes.

type RawEntry = {
    name: string
    data: Uint8Array
    method: 0 | 8
    /** The stored bytes, when they differ from what `data` compresses to. */
    stored?: Uint8Array
    descriptor?: 'signed' | 'unsigned'
    localExtra?: Uint8Array
    centralExtra?: Uint8Array
    zip64?: boolean
}

const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff]
const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
const u64 = (n: number) => [...u32(n % 2 ** 32), ...u32(Math.floor(n / 2 ** 32))]

const concat = (parts: (Uint8Array | number[])[]) => {
    const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
    let at = 0
    for (const part of parts) {
        out.set(part, at)
        at += part.length
    }
    return out
}

const writeRaw = (
    entries: RawEntry[],
    { comment, zip64End }: { comment?: Uint8Array; zip64End?: boolean } = {},
) => {
    const encoder = new TextEncoder()
    const locals: Uint8Array[] = []
    const centrals: Uint8Array[] = []
    let offset = 0
    for (const entry of entries) {
        const name = encoder.encode(entry.name)
        const stored =
            entry.stored ??
            (entry.method === 8 ? new Uint8Array(deflateRawSync(entry.data)) : entry.data)
        const crc = crc32(entry.data)
        const flags = 0x0800 | (entry.descriptor ? 8 : 0)
        const size = entry.data.length
        const csize = stored.length
        const zip64Local = entry.zip64 ? [...u16(1), ...u16(16), ...u64(size), ...u64(csize)] : []
        const localExtra = concat([zip64Local, entry.localExtra ?? []])
        const hidden = !!entry.descriptor
        const descriptor = !entry.descriptor
            ? []
            : [
                  ...(entry.descriptor === 'signed' ? u32(0x08074b50) : []),
                  ...u32(crc),
                  ...u32(csize),
                  ...u32(size),
              ]
        locals.push(
            concat([
                [
                    ...u32(0x04034b50),
                    ...u16(20),
                    ...u16(flags),
                    ...u16(entry.method),
                    ...u16(0),
                    ...u16(33),
                ],
                u32(hidden ? 0 : crc),
                u32(entry.zip64 ? 0xffffffff : hidden ? 0 : csize),
                u32(entry.zip64 ? 0xffffffff : hidden ? 0 : size),
                [...u16(name.length), ...u16(localExtra.length)],
                name,
                localExtra,
                stored,
                descriptor,
            ]),
        )
        const zip64Central = entry.zip64
            ? [...u16(1), ...u16(24), ...u64(size), ...u64(csize), ...u64(offset)]
            : []
        const centralExtra = concat([zip64Central, entry.centralExtra ?? []])
        centrals.push(
            concat([
                [
                    ...u32(0x02014b50),
                    ...u16(20),
                    ...u16(20),
                    ...u16(flags),
                    ...u16(entry.method),
                    ...u16(0),
                    ...u16(33),
                ],
                u32(crc),
                u32(entry.zip64 ? 0xffffffff : csize),
                u32(entry.zip64 ? 0xffffffff : size),
                [...u16(name.length), ...u16(centralExtra.length), ...u16(0), ...u16(0), ...u16(0)],
                [...u32(0), ...u32(entry.zip64 ? 0xffffffff : offset)],
                name,
                centralExtra,
            ]),
        )
        offset += locals.at(-1)?.length ?? 0
    }
    const directory = concat(centrals)
    const tail = comment ?? new Uint8Array(0)
    const parts: (Uint8Array | number[])[] = [...locals, directory]
    if (zip64End) {
        const at = offset + directory.length
        parts.push(
            [...u32(0x06064b50), ...u64(44), ...u16(45), ...u16(45), ...u32(0), ...u32(0)],
            [
                ...u64(entries.length),
                ...u64(entries.length),
                ...u64(directory.length),
                ...u64(offset),
            ],
            [...u32(0x07064b50), ...u32(0), ...u64(at), ...u32(1)],
            [
                ...u32(0x06054b50),
                ...u16(0),
                ...u16(0),
                ...u16(0xffff),
                ...u16(0xffff),
                ...u32(0xffffffff),
                ...u32(0xffffffff),
                ...u16(tail.length),
            ],
        )
    } else {
        parts.push([
            ...u32(0x06054b50),
            ...u16(0),
            ...u16(0),
            ...u16(entries.length),
            ...u16(entries.length),
            ...u32(directory.length),
            ...u32(offset),
            ...u16(tail.length),
        ])
    }
    parts.push(tail)
    return concat(parts)
}

/** The golden's first file as raw entries, to rewrite as another tool would. */
const goldenEntries = async () => {
    const reader = await ZipReader.open(new Blob([readFileSync(join(goldenRoot, 'write-1.nxsp'))]))
    const entries: RawEntry[] = []
    for (const entry of reader.entries)
        entries.push({
            name: entry.name,
            data: await reader.read(entry, { maxSize: 1 << 30 }),
            method: entry.method === 0 ? 0 : 8,
        })
    return entries
}

type Case = {
    plan: WritePlan
    sources: Record<string, Uint8Array>
    hook?: { change: string }
    /** Set by the runner from the executor; a generator never guesses it. */
    error?: string
}

const pinnedOf = async (name: string, bytes: Uint8Array) =>
    inspectNxsp(new Blob([new Uint8Array(bytes)]), {
        token: name,
        role: 'target',
        fingerprint: await zipFingerprint(new Blob([new Uint8Array(bytes)]), 0),
    })

/** The append from the golden chain onto a source file. */
const appendOnto = async (bytes: Uint8Array) => {
    const c = chain()
    const chunks = fixedChunks(c.store)
    const source = await pinnedOf('source.nxsp', bytes)
    return planNxsp(secondInput(c, chunks, source.entries, 'source.nxsp'), [source]).plan
}

const freshPlan = () => {
    const c = chain()
    return planNxsp(firstInput(c, fixedChunks(c.store))).plan
}

const withEntry = (
    plan: WritePlan,
    name: string,
    change: (entry: PlannedEntry) => PlannedEntry,
): WritePlan => ({
    ...plan,
    entries: plan.entries.map((entry) => (entry.name === name ? change(entry) : entry)),
})

const generate = async (): Promise<Record<string, Case>> => {
    const golden = new Uint8Array(readFileSync(join(goldenRoot, 'write-1.nxsp')))
    const entries = await goldenEntries()
    const sourceOnly = (bytes: Uint8Array) => ({ 'source.nxsp': bytes })

    // Awkward sources: what an OS re-zip or another tool writes.
    const deflated = writeRaw(
        entries.map((e, i) => ({ ...e, method: 8, descriptor: i % 2 ? 'unsigned' : 'signed' })),
    )
    const timestamp = (n: number) =>
        new Uint8Array([...u16(0x5455), ...u16(n), 1, ...new Array<number>(n - 1).fill(7)])
    const localExtra = writeRaw(
        entries.map((e) => ({ ...e, localExtra: timestamp(9), centralExtra: timestamp(5) })),
    )
    const zip64 = writeRaw(
        entries.map((e) => ({ ...e, zip64: true })),
        { zip64End: true },
    )
    const comment = writeRaw(entries, {
        comment: new Uint8Array([
            ...new TextEncoder().encode('note '),
            ...u32(0x06054b50),
            1,
            2,
            3,
            4,
            5,
            6,
            7,
            8,
        ]),
    })
    const chunksDeflated = (stored: (full: Uint8Array) => Uint8Array, declared?: number) =>
        writeRaw(
            entries.map((e) =>
                e.name === 'history/chunks.bin'
                    ? {
                          ...e,
                          method: 8,
                          data: declared === undefined ? e.data : e.data.subarray(0, declared),
                          stored: stored(new Uint8Array(deflateRawSync(e.data))),
                      }
                    : e,
            ),
        )
    const trailing = chunksDeflated((full) => new Uint8Array([...full, 0]))
    const truncated = chunksDeflated((full) => full.subarray(0, full.length - 1))
    const bomb = chunksDeflated((full) => full, 100)
    const flipped = writeRaw(
        entries.map((e) =>
            e.name === 'history/chunks.bin'
                ? { ...e, stored: e.data.map((byte) => byte ^ 0xff) }
                : e,
        ),
    )

    const append = await appendOnto(golden)
    const fresh = freshPlan()
    const deflatedPlan = await appendOnto(deflated)
    const cases: Record<string, Case> = {
        fresh: { plan: fresh, sources: {} },
        append: { plan: append, sources: sourceOnly(golden) },
        'source-deflated-descriptors': { plan: deflatedPlan, sources: sourceOnly(deflated) },
        'source-local-extra': {
            plan: await appendOnto(localExtra),
            sources: sourceOnly(localExtra),
        },
        'source-zip64': { plan: await appendOnto(zip64), sources: sourceOnly(zip64) },
        'source-comment-signature': {
            plan: await appendOnto(comment),
            sources: sourceOnly(comment),
        },
        'fail-crc-mismatch': { plan: await appendOnto(flipped), sources: sourceOnly(flipped) },
        'fail-inflate-trailing': {
            plan: await appendOnto(trailing),
            sources: sourceOnly(trailing),
        },
        'fail-inflate-truncated': {
            plan: await appendOnto(truncated),
            sources: sourceOnly(truncated),
        },
        'fail-bomb': { plan: await appendOnto(bomb), sources: sourceOnly(bomb) },
        'fail-changed-source': {
            plan: append,
            sources: sourceOnly(golden),
            hook: { change: 'source.nxsp' },
        },
        'fail-method-mismatch': {
            plan: withEntry(append, append.entries.at(-1)?.name ?? '', (e) => ({
                ...e,
                method: 8,
            })),
            sources: sourceOnly(golden),
        },
        'fail-wrong-crc': {
            plan: withEntry(fresh, 'project.json', (e) => ({
                ...e,
                crc32: ((e.crc32 ?? 0) + 1) >>> 0,
            })),
            sources: {},
        },
        'fail-too-many-entries': {
            plan: {
                modified: fresh.modified,
                entries: Array.from({ length: 65535 }, (_, i) => ({
                    name: String(i),
                    method: 0,
                    parts: [],
                })),
            },
            sources: {},
        },
        'fail-method8-two-parts': {
            plan: withEntry(fresh, 'project.json', (e) => ({
                ...e,
                parts: [...e.parts, ...e.parts],
            })),
            sources: {},
        },
        'fail-method8-inflate': {
            plan: withEntry(deflatedPlan, deflatedPlan.entries.at(-1)?.name ?? '', (e) => ({
                ...e,
                method: 8,
            })),
            sources: sourceOnly(deflated),
        },
        'fail-dataoffset-mismatch': {
            plan: withEntry(append, 'history/chunks.bin', (e) => ({
                ...e,
                parts: e.parts.map((part) =>
                    part.kind === 'copy' ? { ...part, dataOffset: part.dataOffset + 1 } : part,
                ),
            })),
            sources: sourceOnly(golden),
        },
    }
    return cases
}

const executionSources = (
    pinned: Record<string, PinnedSource>,
    dir: string,
    hook?: { change: string },
) =>
    new Map(
        Object.entries(pinned).map(([name, source]) => [
            name,
            {
                file: new Blob([readFileSync(join(dir, name))]),
                fingerprint: source.fingerprint,
                role: 'target' as const,
                readFingerprint: async () =>
                    hook?.change === name ? `${source.fingerprint}:changed` : source.fingerprint,
            },
        ]),
    )

const pinnedJson = (source: PinnedSource) => ({
    fingerprint: source.fingerprint,
    size: source.size,
    entries: source.entries,
})

const writeCase = async (name: string, c: Case) => {
    const dir = join(root, name)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const pinned: Record<string, unknown> = {}
    const sources: Record<string, PinnedSource> = {}
    for (const [file, bytes] of Object.entries(c.sources)) {
        writeFileSync(join(dir, file), bytes)
        sources[file] = await pinnedOf(file, bytes)
        pinned[file] = pinnedJson(sources[file])
    }
    writeFileSync(join(dir, 'plan.json'), `${JSON.stringify(planToJson(c.plan))}\n`)
    writeFileSync(join(dir, 'pinned.json'), `${JSON.stringify(pinned, null, 2)}\n`)
    if (c.hook) writeFileSync(join(dir, 'hook.json'), `${JSON.stringify(c.hook)}\n`)
    try {
        const file = await executePlan(c.plan, executionSources(sources, dir, c.hook))
        assert.ok(!name.startsWith('fail-'), `${name} succeeded`)
        writeFileSync(join(dir, 'expected.nxsp'), new Uint8Array(await file.arrayBuffer()))
    } catch (error) {
        if (!(error instanceof ExecutionError)) throw error
        assert.ok(name.startsWith('fail-'), `${name} failed: ${error.message}`)
        writeFileSync(join(dir, 'expected-error.json'), `${JSON.stringify({ code: error.code })}\n`)
    }
}

test('the plan conformance set: the web executor gives each expected file or error', async () => {
    if (writing) {
        for (const [name, c] of Object.entries(await generate())) await writeCase(name, c)
    }
    const cases = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
    assert.ok(cases.length >= 17)
    for (const { name } of cases) {
        const dir = join(root, name)
        const plan = planFromJson(JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')) as Json)
        const pinned = JSON.parse(readFileSync(join(dir, 'pinned.json'), 'utf8')) as Record<
            string,
            ReturnType<typeof pinnedJson>
        >
        // Each source's inspect gives `pinned.json`.
        const sources: Record<string, PinnedSource> = {}
        for (const [file, expected] of Object.entries(pinned)) {
            const bytes = new Uint8Array(readFileSync(join(dir, file)))
            const source = await pinnedOf(file, bytes)
            assert.deepEqual(pinnedJson(source), expected, `${name}: ${file}`)
            sources[file] = source
        }
        const hook = existsSync(join(dir, 'hook.json'))
            ? (JSON.parse(readFileSync(join(dir, 'hook.json'), 'utf8')) as { change: string })
            : undefined
        const run = executePlan(plan, executionSources(sources, dir, hook))
        if (existsSync(join(dir, 'expected.nxsp'))) {
            const file = new Uint8Array(await (await run).arrayBuffer())
            assert.deepEqual(file, new Uint8Array(readFileSync(join(dir, 'expected.nxsp'))), name)
        } else {
            const { code } = JSON.parse(readFileSync(join(dir, 'expected-error.json'), 'utf8')) as {
                code: string
            }
            await assert.rejects(
                run,
                (error: unknown) => error instanceof ExecutionError && error.code === code,
                name,
            )
        }
    }
})
