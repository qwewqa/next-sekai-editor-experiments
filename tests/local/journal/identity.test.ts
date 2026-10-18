import assert from 'node:assert/strict'
import test from 'node:test'
import { toHex } from '../../../src/local/hash'
import type { JournalDescriptor } from '../../../src/local/journal/format'
import { createWorld } from '../../../src/local/testing/world'
import { rows, workerCore } from '../flush/harness'
import { goldenChart, stateOf } from '../records/charts'
import { widen } from '../timeline/helpers'
import { append, beginSession, openJournalPage, replayAll } from './harness'

// Replay's identity unit (§1.6.4 step 4): the descriptor's `docId`, `revision` and `file` replace
// the record's together, only when the session is still the head, the `docId` is the record's,
// the descriptor's revision descends from the record's, and, when the record has `replaced`,
// the binding's `at` is above `replaced.at` (D5). `name` and `renames` are taken at the head.

type Row = Record<string, unknown>

const hash = new Uint8Array(16).fill(7)
const handle = { kind: 'file', name: 'coconut.nxsp' }

/** The record's binding: saved at 100, its handle in the `handles` store (D24). */
const recordFile = {
    name: 'coconut.nxsp',
    event: 'saved',
    at: 100,
    hash,
    options: { history: true, bgm: true },
}

/** The journal's binding: a later write-back, at 200, with no handle and its hash as hex. */
const journalFile = {
    name: 'coconut.nxsp',
    event: 'saved',
    at: 200,
    hash: toHex(new Uint8Array(16).fill(9)),
    options: { history: true, bgm: true },
}

/**
 * A stored session whose chain the record binds, then a journal whose descriptor `change` sets,
 * replayed by the next load: the chain record as replay left it.
 */
const replayWith = async (
    seed: number,
    record: Row,
    change: (descriptor: JournalDescriptor) => void,
) => {
    const world = createWorld({ seed })
    const page = await openJournalPage(world, 'a')
    const a = stateOf(goldenChart())
    const session = beginSession(page, a)
    await page.flusher.flush({ strict: true })
    const other = world.tab('other')
    const core = workerCore(world, other)
    await other.run(() => core.start())
    await other.run(() =>
        core.write(['chains', 'handles'], async (tx) => {
            const chain = (await tx.get('chains', session.chainId)) as Row
            await tx.put('chains', { ...chain, ...record })
            if ('file' in record)
                await tx.put('handles', {
                    chainId: session.chainId,
                    role: 'file',
                    name: recordFile.name,
                    handle,
                })
        }),
    )
    append(page, 'edit', 'Changed note', widen(a))
    assert.equal(page.writer.write(), true)
    const key = `nse.journal.${session.id}`
    const journal = JSON.parse(page.storage.getItem(key) ?? '') as { descriptor: JournalDescriptor }
    change(journal.descriptor)
    page.storage.setItem(key, JSON.stringify(journal))
    const { outcomes } = await replayAll(world, page.storage)
    assert.equal(outcomes[0]?.kind, 'applied')
    const stored = [...rows(world, 'handles').values()].find(
        (row) => row.chainId === session.chainId && row.role === 'file',
    )
    return {
        chain: rows(world, 'chains').get(session.chainId) as Row,
        handle: stored?.handle,
        session,
    }
}

const bound = { revision: { id: 'r1', n: 1, ancestors: [] }, file: recordFile }

/** A write-back the tab didn't live to commit: revision r2 descends from r1. */
const writeBack = (descriptor: JournalDescriptor) => {
    descriptor.revision = { id: 'r2', n: 2, ancestors: ['r1'] }
    descriptor.file = journalFile
    descriptor.name = 'Coconut (Master)'
    descriptor.renames = [{ name: 'Coconut', at: 50 }]
}

test('a descending revision takes the identity as one unit, the handle kept for the same file', async () => {
    const { chain, handle: kept } = await replayWith(1, bound, writeBack)
    assert.deepEqual(chain.revision, { id: 'r2', n: 2, ancestors: ['r1'] })
    const file = chain.file as Row
    assert.equal(file.at, 200)
    assert.deepEqual(file.hash, new Uint8Array(16).fill(9))
    assert.equal(file.handle, undefined)
    assert.deepEqual(kept, handle)
    assert.equal(chain.name, 'Coconut (Master)')
    assert.deepEqual(chain.renames, [{ name: 'Coconut', at: 50 }])
})

test('a binding to another file is taken without the old handle', async () => {
    const { chain, handle: kept } = await replayWith(2, bound, (descriptor) => {
        writeBack(descriptor)
        descriptor.file = { ...journalFile, name: 'other.nxsp' }
    })
    const file = chain.file as Row
    assert.equal(file.name, 'other.nxsp')
    assert.equal(kept, undefined)
})

for (const [name, record, change] of [
    [
        'a revision that does not descend',
        bound,
        (descriptor: JournalDescriptor) => {
            writeBack(descriptor)
            descriptor.revision = { id: 'r2', n: 2, ancestors: ['elsewhere'] }
        },
    ],
    [
        'another docId (an unlink or a Save As)',
        bound,
        (descriptor: JournalDescriptor) => {
            writeBack(descriptor)
            descriptor.docId = 'another-doc'
        },
    ],
    [
        'a binding a save picker took over since (D5)',
        { ...bound, replaced: { by: 'other-chain', at: 300, name: 'coconut.nxsp' } },
        writeBack,
    ],
    ['a record with a file but no revision', { file: recordFile }, writeBack],
] as const)
    test(`${name} never writes the identity over the record`, async () => {
        const { chain, handle: kept } = await replayWith(3, record, change)
        assert.deepEqual(chain.revision, 'revision' in record ? record.revision : undefined)
        const file = chain.file as Row
        assert.equal(file.at, 100)
        assert.deepEqual(kept, handle)
        // The other known fields are taken all the same: the session is still the head.
        assert.equal(chain.name, 'Coconut (Master)')
    })

test('a record with no revision and no file takes a first Save’s binding (D15)', async () => {
    const { chain, handle: kept } = await replayWith(5, {}, writeBack)
    assert.deepEqual(chain.revision, { id: 'r2', n: 2, ancestors: ['r1'] })
    const file = chain.file as Row
    assert.equal(file.at, 200)
    assert.equal(kept, undefined)
})

test('a journal of a chain never saved leaves no revision or file field on the record', async () => {
    const { chain } = await replayWith(7, {}, () => undefined)
    assert.ok(!('revision' in chain))
    assert.ok(!('file' in chain))
})

test('a record with no revision and no file still refuses a binding a save picker took over', async () => {
    const { chain } = await replayWith(
        6,
        { replaced: { by: 'other-chain', at: 300, name: 'coconut.nxsp' } },
        writeBack,
    )
    assert.equal(chain.revision, undefined)
    assert.equal(chain.file, undefined)
})

test('a binding newer than the record’s replaced mark is taken', async () => {
    const { chain } = await replayWith(
        4,
        { ...bound, replaced: { by: 'other-chain', at: 150, name: 'coconut.nxsp' } },
        writeBack,
    )
    assert.equal((chain.file as Row).at, 200)
})
