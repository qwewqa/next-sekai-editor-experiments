import assert from 'node:assert/strict'
import test from 'node:test'
import { holdsHistory, readReplaceDecision, relation } from '../../../src/local/save/predicate'
import { nxspDiskState } from '../../../src/platform/fingerprint'
import { Fixture, heldRows, save } from './fixture'

// The content predicate and the Replace guard (Part 0 §0.9.5–§0.9.6; Part 1 §1.6.11.6;
// r12-history-critique §2, r12-freeze2 S5).

test('N holds O by ancestry, completeFrom and entry count; relations as §0.9.5', () => {
    const o = { revision: { id: 'b', ancestors: ['a'] }, cd: '11111111', entries: 4 }
    const n = {
        revision: { id: 'c', ancestors: ['b', 'a'], completeFrom: 'a' },
        cd: '22222222',
        entries: 6,
    }
    assert.equal(holdsHistory(n, o), true)
    assert.equal(holdsHistory({ ...n, entries: 3 }, o), false)
    assert.equal(holdsHistory({ ...n, revision: { ...n.revision, completeFrom: 'c' } }, o), false)
    // A completeFrom that can't be placed reads as the file's own id.
    assert.equal(holdsHistory({ ...n, revision: { ...n.revision, completeFrom: 'zz' } }, o), false)
    assert.equal(holdsHistory({ ...o }, o), true)
    assert.equal(holdsHistory({ ...o, cd: '33333333' }, o), false)
    assert.equal(relation(n, o), 'newer')
    assert.equal(relation(o, n), 'older')
    assert.equal(relation(o, o), 'same')
    assert.equal(relation({ revision: { id: 'x', ancestors: ['a'] } }, o), 'diverged')
    assert.equal(relation({}, o), 'none')
})

test('Replace is disabled when the file on disk holds the base and the write wouldn’t carry it', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    fixture.undo()
    await fixture.edit(2)
    await fixture.flush()
    const { built, file } = await save(
        fixture,
        { kind: 'copy' },
        { disk: (saved) => nxspDiskState(saved, saved.lastModified).then((disk) => ({ ...disk })) },
    )
    assert.ok(!('refused' in built) && file)
    const { read } = await heldRows(file)
    const base = read.projectJson
    const baseRevision = base.revision as { id: string; ancestors: string[]; completeFrom: string }
    // Another device's append to the file: a descendant that holds the base.
    const descendant = {
        ...base,
        revision: {
            ...baseRevision,
            id: 'other',
            ancestors: [baseRevision.id],
            completeFrom: baseRevision.completeFrom,
        },
        history: { ...(base.history as object), entries: 9 },
    }
    await fixture.edit(3)
    await fixture.flush()
    const decide = () =>
        readReplaceDecision(fixture.store, fixture.chainId, descendant, 'zip:1:1:abcdef01')
    // Every row the base held is still stored: the write carries, so Replace keeps the line.
    assert.deepEqual(await decide(), { holdsBase: false, relation: 'newer' })
    // The chain's base rows reduced: the file on disk is the only holder of them.
    assert.equal(await fixture.thin(0, 1), true)
    assert.deepEqual(await decide(), { holdsBase: true, relation: 'newer' })
    // A diverged version is kept first by Replace instead.
    const diverged = {
        ...descendant,
        revision: { ...descendant.revision, ancestors: ['elsewhere'] },
    }
    assert.deepEqual(
        await readReplaceDecision(fixture.store, fixture.chainId, diverged, 'zip:1:1:abcdef01'),
        { holdsBase: false, relation: 'diverged' },
    )
})
