import assert from 'node:assert/strict'
import test from 'node:test'
import { readNxsp } from '../../../src/local/nxsp/read'
import { writeUnlink } from '../../../src/local/open/importWrite'
import { BIND_STORES, takeOver } from '../../../src/local/save/bind'
import { Fixture, save } from './fixture'

// A chain that loses its file keeps the file's stem as its name (Part 1 §1.3.5): the file's stem
// named it, so its label, its Recent Sessions row and the next Save's prefill keep naming it, not
// the title or "Untitled · date". The stem replaces any name the chain had: every web name is
// automatic, and the file name is the one the user chose last.

type Row = Record<string, unknown>

const FILE_AT = 5

/** A stored chain bound to `fileName`, with `name` when given. */
const boundChain = async (fileName: string, name?: string) => {
    const fixture = await Fixture.create(91)
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.flush()
    await fixture.store.write(BIND_STORES, async (tx) => {
        const chain = (await tx.get('chains', fixture.chainId)) as Row
        await tx.put('chains', {
            ...chain,
            ...(name === undefined ? {} : { name }),
            revision: { id: 'r1', n: 1, ancestors: [] },
            file: { name: fileName, event: 'saved', at: FILE_AT },
        })
    })
    return fixture
}

const chainOf = (fixture: Fixture) =>
    fixture.store.read(['chains'], (tx) => tx.get('chains', fixture.chainId)) as Promise<Row>

const owner = (fixture: Fixture, name: string) => ({
    chainId: fixture.chainId,
    role: 'file' as const,
    name,
    at: FILE_AT,
    handle: false,
})

test('a takeover leaves the chain its file’s stem, dots and all', async () => {
    const fixture = await boundChain('feat. Miku.nxsp')
    const done = await fixture.store.write(BIND_STORES, (tx) =>
        takeOver(tx, { owner: owner(fixture, 'feat. Miku.nxsp'), by: 'other', at: 9 }),
    )
    assert.equal(done.revoked, true)
    const chain = await chainOf(fixture)
    assert.equal(chain.file, undefined)
    assert.equal(chain.name, 'feat. Miku')
})

test('an unlink after damage, Check’s included, leaves the chain its file’s stem', async () => {
    const fixture = await boundChain('coconut.nxsp')
    const record = await fixture.store.write(['chains', 'entries', 'handles'], (tx) =>
        writeUnlink(tx, {
            sessionId: '',
            chainId: fixture.chainId,
            docId: 'doc-2',
            hashes: [],
            roots: [],
            appVersion: '0.6.0',
        }),
    )
    // The record as written is what the page takes for its session and journal.
    assert.equal(record?.name, 'coconut')
    assert.equal((await chainOf(fixture)).name, 'coconut')
})

test('a fork later saved as a file takes that file’s stem over its "(2)" name when it loses it', async () => {
    // A fork "Coconut (2)" saved as melt.nxsp, then taken over or unlinked: it reads "melt".
    const taken = await boundChain('melt.nxsp', 'Coconut (2)')
    await taken.store.write(BIND_STORES, (tx) =>
        takeOver(tx, { owner: owner(taken, 'melt.nxsp'), by: 'other', at: 9 }),
    )
    assert.equal((await chainOf(taken)).name, 'melt')
    const unlinked = await boundChain('melt.nxsp', 'Coconut (2)')
    await unlinked.store.write(['chains', 'entries', 'handles'], (tx) =>
        writeUnlink(tx, {
            sessionId: '',
            chainId: unlinked.chainId,
            docId: 'doc-2',
            hashes: [],
            roots: [],
            appVersion: '0.6.0',
        }),
    )
    assert.equal((await chainOf(unlinked)).name, 'melt')
})

test('the web’s Save writes no project name: its names are automatic, and the apps would show one', async () => {
    const fixture = await Fixture.create(92)
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.flush()
    // A fork's automatic name, which the file would otherwise carry to the apps (Part 3 ND15).
    await fixture.store.write(['chains'], async (tx) => {
        const chain = (await tx.get('chains', fixture.chainId)) as Row
        await tx.put('chains', { ...chain, name: 'Coconut (2)' })
    })
    const { file } = await save(fixture, { kind: 'copy' }, { binds: false })
    assert(file)
    const read = await readNxsp(file)
    assert.equal(read.kind, 'nxsp')
    if (read.kind !== 'nxsp') return
    assert.equal('name' in read.projectJson, false)
})
