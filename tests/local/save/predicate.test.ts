import assert from 'node:assert/strict'
import test from 'node:test'
import { toHex } from '../../../src/local/hash'
import type { ChainCut } from '../../../src/local/save/cut'
import { bindingHasHistory } from '../../../src/local/save/model'
import {
    holdsHistory,
    readReplaceDecision,
    relation,
    replaceDecision,
} from '../../../src/local/save/predicate'
import { nxspDiskState } from '../../../src/platform/fingerprint'
import { Fixture, heldRows, save, stateAt } from './fixture'

// The content predicate and the Replace guard.

test('N holds O by ancestry, completeFrom and entry count', () => {
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
    // A row of the base thinned (flagged, its root removed): the chain can't show it holds them.
    assert.equal(await fixture.thin(0, 1), true)
    assert.deepEqual(await decide(), { holdsBase: 'unproven', relation: 'newer' })
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

test('the Replace guard uses the build’s carry test: a flagged row a kept row shares still carries', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.edit(2)
    fixture.undo()
    await fixture.flush()
    const { built, file } = await save(
        fixture,
        { kind: 'copy' },
        { disk: (saved) => nxspDiskState(saved, saved.lastModified).then((disk) => ({ ...disk })) },
    )
    assert.ok(!('refused' in built) && file)
    const { read } = await heldRows(file)
    const base = read.projectJson
    const revision = base.revision as { id: string; ancestors: string[]; completeFrom: string }
    const descendant = {
        ...base,
        revision: { ...revision, id: 'other', ancestors: [revision.id] },
        history: { ...(base.history as object), entries: 9 },
    }
    // Cleanup flags the edit to state 1; the undo row back to it keeps the state.
    const row = fixture.session.rows.find(
        (each) => each.kind === 'edit' && toHex(each.snapshot) === stateAt(1).hex,
    )
    assert.ok(row)
    await fixture.store.write(['entries'], async (tx) => {
        const stored = (await tx.get('entries', [row.sessionId, row.seq])) as object
        await tx.put('entries', { ...stored, kept: false })
    })
    assert.deepEqual(
        await readReplaceDecision(fixture.store, fixture.chainId, descendant, 'zip:1:1:abcdef01'),
        { holdsBase: false, relation: 'newer' },
    )
})

test('a binding has history when its cut counts an entry: no cut and count 0 are none', () => {
    const cut = { sessionId: 's', seq: 3, startedAt: 1, count: 3, notKept: 0 }
    assert.equal(bindingHasHistory({ entry: cut }), true)
    // An open of a file without history stores a cut of count 0; a Save without History, none.
    const opened = { ...cut, seq: 0, count: 0 }
    assert.equal(bindingHasHistory({ entry: opened }), false)
    assert.equal(bindingHasHistory({}), false)
    assert.equal(bindingHasHistory(undefined), false)
})

test('a base without history holds no earlier steps: Replace stays available', () => {
    const chainCut = (entry?: { count: number }): ChainCut =>
        ({
            chain: {
                chainId: 'c',
                docId: 'd',
                lineageId: 'l',
                revision: { id: 'a', n: 1, ancestors: [] },
                file: {
                    disk: { fingerprint: 'zip:1:1:11111111', size: 1, lastModified: 1 },
                    ...(entry
                        ? {
                              entry: {
                                  sessionId: 's',
                                  seq: entry.count,
                                  startedAt: 1,
                                  notKept: 0,
                                  ...entry,
                              },
                          }
                        : {}),
                },
            },
            sessions: [],
            entries: new Map(),
            unreadable: 0,
            sessionId: undefined,
        }) as unknown as ChainCut
    const disk = {
        revision: { id: 'b', ancestors: ['a'], completeFrom: 'a' },
        cd: '22222222',
        entries: 5,
    }
    // A Save without History: no cut.
    assert.deepEqual(replaceDecision(chainCut(), disk), { holdsBase: false, relation: 'newer' })
    // An open of a file without history: a cut of count 0.
    assert.deepEqual(replaceDecision(chainCut({ count: 0 }), disk), {
        holdsBase: false,
        relation: 'newer',
    })
    // A base with history whose rows storage no longer has is still guarded, with the definite
    // reason: the chain holds fewer of its rows than the file did.
    assert.deepEqual(replaceDecision(chainCut({ count: 4 }), disk), {
        holdsBase: 'missing',
        relation: 'newer',
    })
})

test('a chain saved without History meets a descendant on disk: Replace stays available', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    fixture.undo()
    await fixture.edit(2)
    await fixture.flush()
    const { built, file } = await save(
        fixture,
        { kind: 'copy' },
        {
            extra: { history: false },
            disk: (saved) => nxspDiskState(saved, saved.lastModified).then((disk) => ({ ...disk })),
        },
    )
    assert.ok(!('refused' in built) && file)
    assert.equal(built.identity.entry, undefined)
    const baseId = built.identity.revision.id
    const descendant = {
        revision: { id: 'other', ancestors: [baseId], completeFrom: baseId },
        history: { entries: 5 },
    }
    assert.equal(await fixture.thin(0, 1), true)
    assert.deepEqual(
        await readReplaceDecision(fixture.store, fixture.chainId, descendant, 'zip:1:1:abcdef01'),
        { holdsBase: false, relation: 'newer' },
    )
})
