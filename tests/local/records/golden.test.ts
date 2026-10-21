import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { LEVEL_VERSION } from '../../../src/levelData/levelVersion'
import { deflateChunk, inflateStrict } from '../../../src/local/chunkVerify'
import { hash16, hash16Sync, toHex } from '../../../src/local/hash'
import {
    canonicalBytes,
    canonical as canonicalText,
    type RecordValue,
} from '../../../src/local/records/canonical'
import { extractChart, noteObjectOf } from '../../../src/local/records/extract'
import { inspectRecord } from '../../../src/local/records/inspect'
import {
    fromRecords,
    headerRecord,
    stateFromRecords,
    toRecords,
} from '../../../src/local/records/records'
import { nodeJsonFromRow, nodeRow, rootJsonFromRow, rootRow } from '../../../src/local/records/rows'
import {
    decodeSnapshot,
    encodeSnapshot,
    type EncodedSnapshot,
} from '../../../src/local/records/snapshot'
import { RECORDS_V } from '../../../src/local/records/version'
import { createState, type State } from '../../../src/state'
import { createSlideId } from '../../../src/state/entities/slides'
import { addNote, removeNote, replaceNote } from '../../../src/state/mutations/slides/note'
import { createTransaction } from '../../../src/state/transaction'
import { useDay } from '../../helpers/useDay'
import {
    edgeChart,
    edgeHeaderVariants,
    goldenChart,
    recordsText,
    stateOf,
    type FixtureChart,
} from './charts'

// The snapshot encoding's golden vectors (§1.6.11.1), frozen with v1: every later build
// encodes the golden chart to exactly these records and hashes. `NSE_WRITE_GOLDEN=1` writes
// them; that is done once, before v0.6.0 ships, and never again.

const goldenRoot = join(import.meta.dirname, 'golden-v1')

type Manifest = {
    root: string
    header: string
    nodes: { kind: string; depth: number; hash: string }[]
    chunks: { kind: string; hash: string }[]
    headerVariants?: Record<string, string>
}

const manifestOf = (
    snapshot: EncodedSnapshot,
    headerVariants?: Record<string, string>,
): Manifest => ({
    root: toHex(snapshot.root.hash),
    header: toHex(snapshot.header.hash),
    nodes: snapshot.nodes.map((node) => ({
        kind: node.kind,
        depth: node.depth,
        hash: toHex(node.hash),
    })),
    chunks: snapshot.chunks.map((chunk) => ({ kind: chunk.kind, hash: toHex(chunk.hash) })),
    ...(headerVariants ? { headerVariants } : {}),
})

/** Every record a set pins, by hash: its canonical bytes. */
const recordsOf = (snapshot: EncodedSnapshot, extra: Uint8Array[] = []) => {
    const map = new Map<string, Uint8Array>()
    for (const record of [snapshot.root, snapshot.header, ...snapshot.nodes, ...snapshot.chunks])
        map.set(toHex(record.hash), record.bytes)
    for (const bytes of extra) map.set(toHex(hash16Sync(bytes)), bytes)
    return map
}

type GoldenSet = {
    dir: string
    fixture: FixtureChart
    snapshot: EncodedSnapshot
    variants?: Map<string, Uint8Array>
}

const edgeVariants = (fixture: FixtureChart) => {
    const chart = extractChart(stateOf(fixture))
    return new Map(
        edgeHeaderVariants().map(({ name, levelInfo, bgm }) => [
            name,
            canonicalBytes(
                headerRecord(chart, {
                    bgmOffset: fixture.offset,
                    levelInfo,
                    ...(bgm ? { bgm } : {}),
                }),
            ),
        ]),
    )
}

const sets = (): GoldenSet[] => {
    const golden = goldenChart()
    const edge = edgeChart()
    return [
        { dir: goldenRoot, fixture: golden, snapshot: encodeSnapshot(toRecords(stateOf(golden))) },
        {
            dir: join(goldenRoot, 'edge'),
            fixture: edge,
            snapshot: encodeSnapshot(toRecords(stateOf(edge))),
            variants: edgeVariants(edge),
        },
    ]
}

const variantHashes = (variants?: Map<string, Uint8Array>) =>
    variants &&
    Object.fromEntries([...variants].map(([name, bytes]) => [name, toHex(hash16Sync(bytes))]))

const write = ({ dir, snapshot, variants }: GoldenSet) => {
    mkdirSync(join(dir, 'records'), { recursive: true })
    for (const [hash, bytes] of recordsOf(snapshot, [...(variants?.values() ?? [])]))
        writeFileSync(join(dir, 'records', `${hash}.canonical`), bytes)
    writeFileSync(
        join(dir, 'snapshot.json'),
        `${JSON.stringify(manifestOf(snapshot, variantHashes(variants)), null, 4)}\n`,
    )
}

if (process.env.NSE_WRITE_GOLDEN === '1') for (const set of sets()) write(set)

const readManifest = (dir: string) =>
    JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8')) as Manifest

const readRecords = (dir: string) =>
    new Map(
        readdirSync(join(dir, 'records'))
            .filter((name) => name.endsWith('.canonical'))
            .map((name) => [
                name.slice(0, -'.canonical'.length),
                new Uint8Array(readFileSync(join(dir, 'records', name))),
            ]),
    )

const describe = (bytes: Uint8Array, form: string) =>
    JSON.stringify(inspectRecord(form, JSON.parse(new TextDecoder().decode(bytes))), null, 2)

test('toRecords and the encoder reproduce the golden and edge vectors exactly', () => {
    for (const { dir, snapshot, variants } of sets()) {
        assert.ok(existsSync(join(dir, 'snapshot.json')), `${dir} has no vectors`)
        assert.deepEqual(manifestOf(snapshot, variantHashes(variants)), readManifest(dir), dir)
        const expected = readRecords(dir)
        const actual = recordsOf(snapshot, [...(variants?.values() ?? [])])
        assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), dir)
        for (const [hash, bytes] of actual) {
            const pinned = expected.get(hash)
            assert.ok(pinned)
            if (Buffer.compare(bytes, pinned))
                assert.fail(`${hash} differs:\n${describe(bytes, 'header')}`)
        }
    }
})

test('the golden hashes match an independent SHA-256 and crypto.subtle', async () => {
    for (const { dir } of sets()) {
        for (const [hash, bytes] of readRecords(dir)) {
            // As the README's `uv run python` command recomputes them.
            assert.equal(createHash('sha256').update(bytes).digest('hex').slice(0, 32), hash)
            assert.equal(toHex(hash16Sync(bytes)), hash)
            assert.equal(
                toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 16)),
                hash,
            )
            assert.equal(toHex(await hash16(bytes)), hash)
        }
    }
})

test('the golden root is v 1 at levelVersion 1, and stored forms inflate to the pinned bytes', () => {
    const [golden] = sets()
    assert.ok(golden)
    assert.equal(golden.snapshot.root.v, 1)
    assert.equal(RECORDS_V, 1)
    assert.equal(LEVEL_VERSION, 1)
    for (const [, bytes] of readRecords(golden.dir))
        assert.deepEqual(inflateStrict(deflateChunk(bytes)), bytes)
})

test('records decoded from the vectors give back the chart, and the database rows hash the same', () => {
    for (const { dir, fixture } of sets()) {
        const manifest = readManifest(dir)
        const records = readRecords(dir)
        const parse = (hash: string) => {
            const bytes = records.get(hash)
            assert.ok(bytes, hash)
            return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
        }
        const decoded = decodeSnapshot(parse(manifest.root), { node: parse, chunk: parse })
        const state = stateFromRecords(decoded)
        assert.equal(recordsText(toRecords(state)), recordsText(toRecords(stateOf(fixture))), dir)

        const snapshot = encodeSnapshot(decoded)
        const hashOf = (json: RecordValue) => toHex(hash16Sync(canonicalBytes(json)))
        assert.equal(hashOf(rootJsonFromRow(rootRow(snapshot.root, useDay(0)))), manifest.root)
        for (const node of snapshot.nodes)
            assert.equal(hashOf(nodeJsonFromRow(nodeRow(node, useDay(0)))), toHex(node.hash))
    }
    const golden = goldenChart()
    const content = fromRecords(toRecords(stateOf(golden)))
    assert.deepEqual(content.chart, golden.chart)
})

/** The golden chart's slides, events and BPMs inserted in another order. */
const reordered = (fixture: FixtureChart): State => {
    const chart = structuredClone(fixture.chart)
    chart.slides.reverse()
    chart.bpms.reverse()
    chart.cameraEvents.reverse()
    chart.stageMaskEvents.reverse()
    chart.timeScales.reverse()
    return createState(chart, fixture.offset, fixture.extras)
}

test('two insertion orders give one root hash', () => {
    const fixture = goldenChart()
    const root = (state: State) => toHex(encodeSnapshot(toRecords(state)).root.hash)
    assert.equal(root(reordered(fixture)), root(stateOf(fixture)))
    assert.equal(root(reordered(fixture)), readManifest(goldenRoot).root)
})

test('two same-beat events on one track in the other chain order hash differently and keep their order', () => {
    const fixture = edgeChart()
    const swapped = structuredClone(fixture.chart)
    const [a, b] = swapped.stageMaskEvents
    assert.ok(a && b && a.beat === b.beat && a.stageId === b.stageId)
    swapped.stageMaskEvents.splice(0, 2, b, a)
    const state = createState(swapped, fixture.offset, fixture.extras)
    const records = toRecords(state)
    assert.notEqual(
        toHex(encodeSnapshot(records).root.hash),
        readManifest(join(goldenRoot, 'edge')).root,
    )
    const masks = (s: State) =>
        toRecords(s)
            .kinds.find(({ kind }) => kind === 'stageMaskEvents')
            ?.records.map(({ record }) => record[2])
    assert.deepEqual(masks(state), [-2, -6, -6])
    assert.deepEqual(masks(stateFromRecords(records)), masks(state))
})

test('a slide edited after being created changes nothing but its own chunk', () => {
    const fixture = goldenChart()
    const before = stateOf(fixture)
    const slide = [...before.store.slides.note.values()].find((notes) => notes[0]?.beat === 3)
    assert.ok(slide?.[0])
    // Removed and made again as a new slide: it moves to the end of insertion order.
    const transaction = createTransaction(before)
    const slideId = createSlideId()
    for (const note of slide) removeNote(transaction, note)
    for (const note of slide) addNote(transaction, slideId, noteObjectOf(note))
    const after = transaction.commit([])
    assert.notDeepEqual(
        [...after.store.slides.info.values()].map((infos) => infos[0]?.note.beat),
        [...before.store.slides.info.values()].map((infos) => infos[0]?.note.beat),
    )
    assert.equal(toHex(encodeSnapshot(toRecords(after)).root.hash), readManifest(goldenRoot).root)

    const edited = createTransaction(before)
    replaceNote(edited, slide[0], { ...slide[0], size: 3 })
    const changed = encodeSnapshot(toRecords(edited.commit([])))
    const old = new Set(encodeSnapshot(toRecords(before)).chunks.map((chunk) => toHex(chunk.hash)))
    assert.equal(changed.chunks.filter((chunk) => !old.has(toHex(chunk.hash))).length, 1)
})

test('same-beat BPMs, and same-beat time scales on one group, keep their stored order, not byte order', () => {
    const fixture = edgeChart()
    const state = stateOf(fixture)
    const records = toRecords(state)
    const kind = (s: State, name: string) =>
        toRecords(s)
            .kinds.find((item) => item.kind === name)
            ?.records.map(({ record }) => canonicalText(record))
    const bpms = kind(state, 'bpms')
    const timeScales = kind(state, 'timeScales')
    // Stored order, the reverse of byte order at beat 4 and at beat 5 on group 3.
    assert.deepEqual(bpms?.slice(1, 3), ['[4,200,4]', '[4,150,3]'])
    assert.deepEqual(timeScales?.slice(2), [
        '[3,5,0,3,0,"linear","timeScale",false]',
        '[3,5,0,1,0,"linear","timeScale",false]',
    ])
    const restored = stateFromRecords(records)
    assert.deepEqual(kind(restored, 'bpms'), bpms)
    assert.deepEqual(kind(restored, 'timeScales'), timeScales)
    assert.deepEqual(restored.bpms, state.bpms)

    // In byte order they're another state, with another tempo and another root.
    const swapped = structuredClone(fixture.chart)
    swapped.bpms.splice(3, 2, swapped.bpms[4]!, swapped.bpms[3]!)
    swapped.timeScales.splice(2, 2, swapped.timeScales[3]!, swapped.timeScales[2]!)
    const other = createState(swapped, fixture.offset, fixture.extras)
    assert.notDeepEqual(other.bpms, state.bpms)
    assert.deepEqual(kind(other, 'bpms')?.slice(1, 3), ['[4,150,3]', '[4,200,4]'])
    assert.notEqual(
        toHex(encodeSnapshot(toRecords(other)).root.hash),
        readManifest(join(goldenRoot, 'edge')).root,
    )
})
