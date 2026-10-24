import assert from 'node:assert/strict'
import test from 'node:test'
import { hashKey } from '../../../src/local/db'
import { fromHex16, toHex } from '../../../src/local/hash'
import { KeyRange } from '../../../src/local/kv/types'
import { readEntryRow } from '../../../src/local/save/cut'
import { Fixture, heldRows, save, stateAt } from './fixture'

// A stored entry row's `noteCount`: a row that doesn't say its count
// reads without one, never as 0, and a Save writes its state's own count from the root it holds.

test('an entry row without a note count reads without one, never as 0', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.flush()
    const [row] = (await fixture.entries()).filter((each) => each.kind === 'edit')
    assert.ok(row)
    const without: Record<string, unknown> = { ...row }
    delete without.noteCount
    assert.equal(readEntryRow(without)?.noteCount, undefined)
    assert.equal(readEntryRow({ ...without, noteCount: -1 })?.noteCount, undefined)
    assert.equal(readEntryRow({ ...without, noteCount: 7 })?.noteCount, 7)
})

test('a Save writes a row without a count with its state’s count from the root', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.flush()
    const expected = (await save(fixture, { kind: 'copy' }, { binds: false })).file
    assert.ok(expected)
    // The `save` entry's count is the head's, from its root: state 1's.
    const counted = (await heldRows(expected)).history.entries.find(
        (entry) => entry.kind === 'save' && entry.snapshot === stateAt(1).hex,
    )?.noteCount
    assert.ok(counted !== undefined && counted > 0)
    await fixture.store.write(['entries'], async (tx) => {
        for (const value of (await tx.getAll('entries', KeyRange.lowerBound(['']))) as Record<
            string,
            unknown
        >[]) {
            if (value.kind !== 'edit') continue
            const without = { ...value }
            delete without.noteCount
            await tx.put('entries', without)
        }
    })
    const { file } = await save(fixture, { kind: 'copy' }, { binds: false })
    assert.ok(file)
    const entry = (await heldRows(file)).history.entries.find(
        (each) => each.kind === 'edit' && each.snapshot === stateAt(1).hex,
    )
    assert.equal(entry?.noteCount, counted)
})

test('a Save writes a row whose count no root says without one, never as 0', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.edit(2)
    await fixture.flush()
    const lost = stateAt(1)
    await fixture.store.write(['entries', 'nodes'], async (tx) => {
        await tx.delete('nodes', hashKey(fromHex16(lost.hex)))
        for (const value of (await tx.getAll('entries', KeyRange.lowerBound(['']))) as Record<
            string,
            unknown
        >[]) {
            if (value.kind !== 'edit' || toHex(value.snapshot as Uint8Array) !== lost.hex) continue
            const without = { ...value }
            delete without.noteCount
            await tx.put('entries', without)
        }
    })
    const { file } = await save(fixture, { kind: 'copy' }, { binds: false })
    assert.ok(file)
    const entries = (await heldRows(file)).history.entries
    const entry = entries.find((each) => each.kind === 'edit' && each.snapshot === lost.hex)
    assert.ok(entry)
    assert.equal('noteCount' in entry, false)
    assert.equal(entry.kept, false)
    // The others keep theirs.
    assert.ok(
        entries.filter((each) => each !== entry).every((each) => each.noteCount !== undefined),
    )
})
