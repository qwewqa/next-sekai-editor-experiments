import assert from 'node:assert/strict'
import { test } from 'node:test'
import './env'

// Two readers that act on a chain record: the marker sweep, which
// removes a marker only when the read worked and found no chain, and the binding refresh, which
// changes nothing when the record can't be read.

const { reclaimOrphans, writeMarker, readMarker } = await import('../../../src/editor/save/env')
const { refreshBinding } = await import('../../../src/editor/save/watch')

const failure = () => new Error('The storage worker stopped answering (readers test)')

const marker = (chainId: string) =>
    ({
        chainId,
        entry: { revisionId: `rev-${chainId}` },
        parent: null,
        unit: { docId: `doc-${chainId}`, file: { hash: 'ab' } },
    }) as never

test("a deleted chain's marker and kept bytes are removed, and kept when the read fails", async () => {
    localStorage.clear()
    for (const chainId of ['gone', 'held', 'unreadable']) assert.ok(writeMarker(marker(chainId)))
    const copies = new Set(['gone', 'held', 'unreadable', 'goneCopy'])
    await reclaimOrphans(
        {
            call: (_method, chainId) => {
                if (chainId === 'unreadable') return Promise.reject(failure())
                return Promise.resolve(
                    chainId === 'gone' || chainId === 'goneCopy' ? undefined : { chainId },
                )
            },
        },
        {
            chains: () => Promise.resolve([...copies]),
            remove: (chainId) => {
                copies.delete(chainId)
                return Promise.resolve()
            },
        },
    )
    assert.equal(readMarker('gone'), undefined)
    assert.ok(readMarker('held'))
    assert.ok(readMarker('unreadable'), 'a failed read keeps the marker')
    assert.deepEqual([...copies].sort(), ['held', 'unreadable'])
})

test('a binding refresh whose record read fails changes nothing', async () => {
    localStorage.clear()
    const session = {
        id: 's',
        chainId: 'c',
        stored: true,
        edited: false,
        chain: { file: { name: 'a.nxsp' } },
    }
    const flusher = { session } as never
    const replaced = { by: 'other', at: 5, name: 'a.nxsp' }
    await refreshBinding({ call: () => Promise.reject(failure()) }, flusher)
    assert.equal(session.edited, false)
    assert.deepEqual(session.chain, { file: { name: 'a.nxsp' } })
    // The control: a record that says it was taken over marks the chain edited.
    await refreshBinding({ call: () => Promise.resolve({ replaced }) }, flusher)
    assert.equal(session.edited, true)
    assert.deepEqual((session.chain as { replaced?: unknown }).replaced, replaced)
})

test("a binding refresh reads an untouched continuation's record, and not a new chain's", async () => {
    localStorage.clear()
    const replaced = { by: 'other', at: 5, name: 'a.nxsp' }
    const make = (extra: object) => ({
        id: 's',
        chainId: 'c',
        stored: false,
        edited: false,
        chain: { file: { name: 'a.nxsp' } },
        ...extra,
    })
    let reads = 0
    const worker = {
        call: () => {
            reads += 1
            return Promise.resolve({ replaced })
        },
    }
    const continuation = make({ continuation: true })
    await refreshBinding(worker, { session: continuation } as never)
    assert.equal(reads, 1)
    assert.equal(continuation.edited, true)
    assert.deepEqual((continuation.chain as { replaced?: unknown }).replaced, replaced)
    // A new chain and an unstored fork have no record yet: nothing is read.
    for (const extra of [{}, { continuation: true, forkOf: 'p' }]) {
        const session = make(extra)
        await refreshBinding(worker, { session } as never)
        assert.equal(reads, 1)
        assert.equal(session.edited, false)
    }
})
