import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { samplesDir } from '../../scripts/samples.mjs'
import { decodeOperation } from '../../src/history/operations/registry'
import { DB_VERSION } from '../../src/local/db'
import { decodeValue, readDump } from '../../src/local/dump'
import { seedDump } from '../../src/local/seed'
import { createWorld } from '../../src/local/testing/world'

// The format guard for samples/long-history.json (served at ?seedSample=long-history). The dump
// holds History operations as the codecs of the build that generated it; a codec change can leave
// them unsupported. Regenerate with `npm run samples:long-history`.

const root = resolve(import.meta.dirname, '../..')
const dir = samplesDir(root)
const file = dir && join(dir, 'long-history.json')
const present = !!file && existsSync(file)
const REGENERATE = 'Run `npm run samples:long-history` to regenerate samples/long-history.json.'

/** Every operation in the entries and the undo-stack blocks: the `operation` of an entry or step, a recovery context's head and dropped steps. */
const operationsOf = (value: unknown, found: unknown[] = []) => {
    if (Array.isArray(value)) for (const item of value) operationsOf(item, found)
    else if (typeof value === 'object' && value !== null && !(value instanceof Uint8Array))
        for (const [key, child] of Object.entries(value)) {
            if (key === 'operation') found.push(child)
            else operationsOf(child, found)
        }
    return found
}

const stale = (json: unknown) => {
    const dump = readDump(json)
    const operations = dump.stores
        .filter((store) => store.name === 'entries' || store.name === 'stackBlocks')
        .flatMap((store) =>
            store.records.flatMap((record) => operationsOf(decodeValue(record.value))),
        )
    const unknown = operations.filter((raw) => decodeOperation(raw as never).status !== 'known')
    return { total: operations.length, unknown }
}

const load = () => JSON.parse(readFileSync(file!, 'utf8')) as unknown

test(
    'every operation in the long-history sample is known to the current codecs',
    { skip: !present },
    () => {
        const { total, unknown } = stale(load())
        assert.ok(total > 0, 'The sample has no operations')
        assert.equal(
            unknown.length,
            0,
            `${unknown.length} of ${total} operations are not known, such as ${JSON.stringify(unknown[0])}. ${REGENERATE}`,
        )
    },
)

test('the long-history sample is at the current database version', { skip: !present }, () => {
    assert.equal(
        readDump(load()).database.version,
        DB_VERSION,
        `The sample is not at database version ${DB_VERSION}. ${REGENERATE}`,
    )
})

test('the seeder accepts the long-history sample', { skip: !present }, async () => {
    const world = createWorld()
    const tab = world.tab('a')
    const items = new Map<string, string>()
    const result = await tab.run(() =>
        seedDump(tab.kv, readDump(load()), { setItem: (key, value) => void items.set(key, value) }),
    )
    assert.deepEqual(result, { seeded: true }, `The seeder refused the sample. ${REGENERATE}`)
    await world.idle()
})
