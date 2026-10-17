import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { hash16Sync, toHex } from '../../../src/local/hash'
import { canonical, canonicalBytes, type RecordValue } from '../../../src/local/records/canonical'
import { toRecords } from '../../../src/local/records/records'
import {
    checkHeader,
    checkRecord,
    kindRecords,
    SchemaError,
    type KindName,
    type RecordName,
} from '../../../src/local/records/schema'
import {
    checkNode,
    checkRoot,
    decodeSnapshot,
    encodeSnapshot,
} from '../../../src/local/records/snapshot'
import { edgeChart, goldenChart, stateOf } from './charts'
import { samplePaths, sampleState } from './samples'

const vectors = join(import.meta.dirname, 'schema-v1')

/** A snapshot vector: its root's hash and every record it reaches, by hash. */
type SnapshotVector = { root: string; records: Record<string, RecordValue> }

const decodeVector = ({ root, records }: SnapshotVector) => {
    // The vector itself is intact: every record hashes to its name.
    for (const [hash, json] of Object.entries(records))
        assert.equal(toHex(hash16Sync(canonicalBytes(json))), hash)
    const get = (hash: string) => records[hash]
    return decodeSnapshot(get(root), { node: get, chunk: get })
}

const check = (record: string, value: unknown) => {
    if (record === 'snapshot') decodeVector(value as SnapshotVector)
    else if (record === 'header') checkHeader(value)
    else if (record === 'root') checkRoot(value)
    else if (record === 'node') checkNode(value, (value as [KindName])[0])
    else checkRecord(record as RecordName, value)
}

const read = (folder: string) =>
    readdirSync(join(vectors, folder))
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
            const { record, value } = JSON.parse(
                readFileSync(join(vectors, folder, name), 'utf8'),
            ) as { record: string; value: unknown }
            return { name, record, value }
        })

test('the schema-v1 vectors: accepted ones pass, rejected ones fail', () => {
    const accepted = read('accepted')
    const rejected = read('rejected')
    assert.ok(accepted.length >= 14 && rejected.length >= 38)
    for (const { name, record, value } of accepted)
        assert.doesNotThrow(() => check(record, value), name)
    for (const { name, record, value } of rejected)
        assert.throws(() => check(record, value), SchemaError, name)
})

test('every record the editor writes passes the schema', () => {
    const states = [stateOf(goldenChart()), stateOf(edgeChart()), ...samplePaths.map(sampleState)]
    for (const state of states) {
        const records = toRecords(state)
        // Canonical bytes parsed back, as a reader meets them.
        const parse = (value: RecordValue) => JSON.parse(canonical(value)) as unknown
        checkHeader(parse(records.header))
        for (const { kind, records: list } of records.kinds)
            for (const { record } of list) checkRecord(kindRecords[kind], parse(record))
        const snapshot = encodeSnapshot(records)
        checkRoot(parse(snapshot.root.json))
        for (const node of snapshot.nodes) checkNode(parse(node.json), node.kind, node.depth)
    }
})

test('a duplicate id, or a folder id in both folder maps, is rejected', () => {
    const header = JSON.parse(canonical(toRecords(stateOf(goldenChart())).header)) as unknown[]
    checkHeader(header)
    const replace = (at: number, value: unknown) =>
        header.map((item, i) => (i === at ? value : item))
    const groups = header[3] as unknown[]
    assert.throws(
        () => checkHeader(replace(3, [...groups, [1, 'Again', 0]])),
        /header\.groups\[2\]\.id: duplicate id 1/,
    )
    assert.throws(
        () => checkHeader(replace(6, [[1, 'Stage folder', 0]])),
        /header\.stageFolders\[0\]\.id: duplicate id 1/,
    )
})
