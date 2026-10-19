import assert from 'node:assert/strict'
import test from 'node:test'
import { BIND_STORES, finishOwnSave } from '../../../src/local/save/bind'
import {
    commitIdentity,
    IDENTITY_STORES,
    storeMarks,
    type IdentityUnit,
} from '../../../src/local/save/commit'
import { futureFixtureOperation } from '../../helpers/historySteps'
import { Fixture } from './fixture'

test('stale Save plans cannot partially mark or bind unsupported session generations', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1, futureFixtureOperation('futureSaveSource', { extra: ['kept'] }))
    await fixture.flush()
    const current = fixture.session.id
    const row = (await fixture.store.read(['sessions'], (tx) =>
        tx.get('sessions', current),
    )) as Record<string, unknown>
    const unit: IdentityUnit = {
        clearExport: true,
        docId: 'replacement-doc',
        revision: { id: 'new-revision', n: 1, ancestors: [] },
        file: { name: 'new.nxsp', entry: { sessionId: current } },
        marks: [
            { sessionId: current, seq: 1 },
            { sessionId: 'old-generation', seq: 1 },
        ],
    }
    await fixture.store.write(['sessions', 'entries', 'chains'], async (tx) => {
        await tx.put('sessions', { ...row, id: 'old-generation', v: 1 })
        await tx.put('entries', {
            sessionId: 'old-generation',
            seq: 1,
            kept: true,
            operation: { unknown: 'intact' },
        })
        const chain = (await tx.get('chains', fixture.chainId)) as Record<string, unknown>
        await tx.put('chains', { ...chain, exportName: 'keep me' })
    })
    const snapshot = () =>
        fixture.store.read(BIND_STORES, async (tx) =>
            Promise.all(BIND_STORES.map((store) => tx.getAll(store))),
        )
    const before = await snapshot()
    assert.equal(
        await fixture.store.write(IDENTITY_STORES, (tx) => storeMarks(tx, unit.marks)),
        false,
    )
    assert.deepEqual(await snapshot(), before)
    assert.equal(
        await fixture.store.write(IDENTITY_STORES, (tx) =>
            commitIdentity(tx, fixture.chainId, unit),
        ),
        false,
    )
    assert.deepEqual(await snapshot(), before)
    const saveEntry = {
        sessionId: current,
        seq: 3,
        time: 1234,
        operation: futureFixtureOperation('futureSave'),
        snapshot: fixture.head,
        noteCount: 1,
        revisionId: 'new-revision',
        device: { id: 'test', label: 'Test' },
    }
    assert.equal(
        await fixture.store.write(BIND_STORES, (tx) =>
            finishOwnSave(tx, fixture.chainId, saveEntry, unit),
        ),
        false,
    )
    assert.deepEqual(await snapshot(), before)

    const ownOnly = { ...unit, marks: [{ sessionId: current, seq: 1 }] }
    for (const v of [undefined, 1, 3]) {
        await fixture.store.write(['sessions'], (tx) => tx.put('sessions', { ...row, v }))
        const held = await snapshot()
        assert.equal(
            await fixture.store.write(IDENTITY_STORES, (tx) =>
                commitIdentity(tx, fixture.chainId, ownOnly),
            ),
            false,
        )
        assert.equal(
            await fixture.store.write(BIND_STORES, (tx) =>
                finishOwnSave(tx, fixture.chainId, saveEntry, ownOnly),
            ),
            false,
        )
        assert.deepEqual(await snapshot(), held)
    }
    await fixture.store.write(['sessions'], (tx) => tx.put('sessions', row))
    assert.equal(
        await fixture.store.write(IDENTITY_STORES, (tx) =>
            commitIdentity(tx, fixture.chainId, ownOnly),
        ),
        true,
    )
    const marked = (await fixture.store.read(['entries'], (tx) =>
        tx.get('entries', [current, 1]),
    )) as { kept: boolean }
    assert.equal(marked.kept, false)
})

test('Save marker completion advances the source time only when its sequence becomes latest', async () => {
    for (const historical of [false, true]) {
        const fixture = await Fixture.create()
        await fixture.start(0)
        await fixture.edit(1)
        if (historical) await fixture.edit(2)
        await fixture.flush()
        const id = fixture.session.id
        const before = (await fixture.store.read(['sessions'], (tx) =>
            tx.get('sessions', id),
        )) as Record<string, unknown>
        const seq = historical ? 2 : 3
        if (historical)
            await fixture.store.write(['entries'], (tx) => tx.delete('entries', [id, seq]))
        const unit: IdentityUnit = {
            docId: fixture.docId,
            revision: { id: 'marker-revision', n: 1, ancestors: [] },
            file: { name: 'marker.nxsp', entry: { sessionId: id } },
            marks: [],
        }
        const entry = {
            sessionId: id,
            seq,
            time: 2000000,
            operation: futureFixtureOperation('save-marker'),
            snapshot: fixture.head,
            noteCount: 1,
            revisionId: 'marker-revision',
            device: { id: 'test', label: 'Test' },
        }
        assert.equal(
            await fixture.store.write(BIND_STORES, (tx) =>
                finishOwnSave(tx, fixture.chainId, entry, unit, 2000000),
            ),
            true,
        )
        const after = (await fixture.store.read(['sessions'], (tx) =>
            tx.get('sessions', id),
        )) as Record<string, unknown>
        const stored = (await fixture.store.read(['entries'], (tx) =>
            tx.get('entries', [id, seq]),
        )) as Record<string, unknown>
        assert.equal(after.updatedAt, historical ? before.updatedAt : stored.time)
        assert.equal(after.lastSeq, 3)
        if (!historical) assert.notEqual(after.updatedAt, before.updatedAt)
        assert.equal(
            await fixture.store.write(BIND_STORES, (tx) =>
                finishOwnSave(tx, fixture.chainId, { ...entry, time: 3000000 }, unit, 3000000),
            ),
            true,
        )
        assert.deepEqual(
            await fixture.store.read(['sessions'], (tx) => tx.get('sessions', id)),
            after,
        )
    }
})

test('Save completion from a supported older session preserves the current session and binds its actual source', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.flush()
    const old = fixture.session.id
    await fixture.start()
    await fixture.flush()
    const current = fixture.session.id
    const currentBefore = await fixture.store.read(['sessions'], (tx) =>
        tx.get('sessions', current),
    )
    const unit: IdentityUnit = {
        docId: fixture.docId,
        revision: { id: 'old-save', n: 1, ancestors: [] },
        file: { name: 'old.nxsp', entry: { sessionId: old } },
        marks: [{ sessionId: old, seq: 1 }],
    }
    const entry = {
        sessionId: old,
        seq: 2,
        time: 2000000,
        operation: futureFixtureOperation('older-session-save'),
        snapshot: fixture.head,
        noteCount: 1,
        revisionId: 'old-save',
        device: { id: 'test', label: 'Test' },
    }
    assert.equal(
        await fixture.store.write(BIND_STORES, (tx) =>
            finishOwnSave(tx, fixture.chainId, entry, unit, 2000000),
        ),
        true,
    )
    assert.deepEqual(
        await fixture.store.read(['sessions'], (tx) => tx.get('sessions', current)),
        currentBefore,
    )
    const source = (await fixture.store.read(['sessions'], (tx) =>
        tx.get('sessions', old),
    )) as Record<string, unknown>
    const event = (await fixture.store.read(['entries'], (tx) =>
        tx.get('entries', [old, 2]),
    )) as Record<string, unknown>
    assert.equal(source.updatedAt, event.time)
    assert.equal(source.lastSeq, 2)
    const chain = (await fixture.store.read(['chains'], (tx) =>
        tx.get('chains', fixture.chainId),
    )) as { head: string; file: { entry: { sessionId: string } } }
    assert.equal(chain.head, current)
    assert.equal(chain.file.entry.sessionId, old)
})
