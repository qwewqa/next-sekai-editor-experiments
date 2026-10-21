import assert from 'node:assert/strict'
import { test } from 'node:test'
import './env'

// Two readers that act on a chain record (Part 1 §1.4.7 R10, §1.6.5): the marker sweep, which
// removes a marker only when the read worked and found no chain, and the binding refresh, which
// changes nothing when the record can't be read.

const { sweepMarkers, writeMarker, readMarker, writeRevocation } =
    await import('../../../src/editor/save/env')
const { refreshBinding } = await import('../../../src/editor/save/watch')

const failure = () => new Error('The storage worker stopped answering (readers test)')

const marker = (chainId: string) =>
    ({
        chainId,
        entry: { revisionId: `rev-${chainId}` },
        parent: null,
        unit: { docId: `doc-${chainId}`, file: { hash: 'ab' } },
    }) as never

test('a marker is removed for a chain storage no longer holds, and kept when the read fails', async () => {
    localStorage.clear()
    for (const chainId of ['gone', 'held', 'unreadable']) assert.ok(writeMarker(marker(chainId)))
    await sweepMarkers({
        call: (_method, chainId) => {
            if (chainId === 'unreadable') return Promise.reject(failure())
            return Promise.resolve(chainId === 'gone' ? undefined : { chainId })
        },
    })
    assert.equal(readMarker('gone'), undefined)
    assert.ok(readMarker('held'))
    assert.ok(readMarker('unreadable'), 'a failed read keeps the marker')
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

test('a failed record read still applies a revocation kept in localStorage to a binding kept in memory (R11)', async () => {
    localStorage.clear()
    assert.ok(writeRevocation('c', { by: 'other', at: 9, name: 'a.nxsp', fileAt: 7 }))
    const session = {
        id: 's',
        chainId: 'c',
        stored: true,
        edited: false,
        identity: { from: { fileAt: 7 } },
        chain: { file: { name: 'a.nxsp', at: 7 } },
    }
    await refreshBinding({ call: () => Promise.reject(failure()) }, { session } as never)
    // The label goes and the chain counts as edited, so closing the tab prompts.
    assert.equal(session.edited, true)
    assert.equal(session.identity, undefined)
    assert.equal((session.chain as { replaced?: { by: string } }).replaced?.by, 'other')
})
