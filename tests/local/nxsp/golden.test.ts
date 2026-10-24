import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { executePlan, inspectNxsp, planNxsp } from '../../../src/local/nxsp'
import { ZipReader } from '../../../src/zip'
import {
    chain,
    describePlan,
    firstInput,
    fixedChunks,
    REV_1,
    REV_2,
    root,
    secondInput,
    writing,
} from './goldenChain'
import { memorySource } from './helpers'

// The builder golden, frozen with v1: a fixed chain (two sessions, a BGM change and a
// cover change, a write-back to its own file) built with fixed `{ now, newId, device, appVersion }`.
// It compares the plan: names, order, methods, CRCs, sizes, `modified`, and each part's kind,
// source and range, with deflated parts compared inflated and JSON as parsed values. The chunks'
// stored forms are inputs (`store.json`), and the second write's source is the committed first
// file, so no pako change touches it. `NSE_WRITE_GOLDEN=1` writes it, once, before v0.6.0 ships.

/** Two files hold the same entries: names, methods, CRCs, sizes and uncompressed bytes. */
const sameEntries = async (actual: Blob, expected: Blob) => {
    const [a, b] = await Promise.all([ZipReader.open(actual), ZipReader.open(expected)])
    assert.deepEqual(
        a.entries.map((e) => [e.name, e.method, e.crc32, e.size, e.flags, e.dosTime, e.dosDate]),
        b.entries.map((e) => [e.name, e.method, e.crc32, e.size, e.flags, e.dosTime, e.dosDate]),
    )
    for (const [i, entry] of a.entries.entries()) {
        const other = b.entries[i]
        assert.ok(other)
        assert.deepEqual(
            await a.read(entry, { maxSize: 1 << 30 }),
            await b.read(other, { maxSize: 1 << 30 }),
            entry.name,
        )
    }
}

const compare = (name: string, value: unknown) => {
    const path = join(root, name)
    const text = `${JSON.stringify(value, null, 2)}\n`
    if (writing) writeFileSync(path, text)
    else assert.deepEqual(value, JSON.parse(readFileSync(path, 'utf8')), name)
}

const file = async (name: string, built: Blob) => {
    const path = join(root, name)
    if (writing) writeFileSync(path, new Uint8Array(await built.arrayBuffer()))
    const committed = new Blob([readFileSync(path)])
    await sameEntries(built, committed)
    return committed
}

test('the builder golden: a fresh write, then a write-back that appends', async () => {
    if (writing && !existsSync(root)) mkdirSync(root, { recursive: true })
    const c = chain()
    const chunks = fixedChunks(c.store)

    const first = planNxsp(firstInput(c, chunks))
    assert.equal(first.revisionId, REV_1)
    compare('plan-1.json', describePlan(first.plan))
    const written1 = await file('write-1.nxsp', await executePlan(first.plan, new Map()))

    const source = await inspectNxsp(written1, {
        token: 'golden',
        role: 'target',
        fingerprint: 'zip:golden',
    })
    const second = planNxsp(secondInput(c, chunks, source.entries), [source])
    assert.equal(second.revisionId, REV_2)
    compare('plan-2.json', describePlan(second.plan))
    await file(
        'write-2.nxsp',
        await executePlan(second.plan, new Map([['golden', memorySource(written1, 'zip:golden')]])),
    )
})
