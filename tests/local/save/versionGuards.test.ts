import assert from 'node:assert/strict'
import test from 'node:test'
import { BIND_STORES, recordOwnSave } from '../../../src/local/save/bind'
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
            { sessionId: 'bad-version', seq: 1 },
        ],
    }
    await fixture.store.write(['sessions', 'entries', 'chains'], async (tx) => {
        await tx.put('sessions', { ...row, id: 'bad-version', v: 0 })
        await tx.put('entries', {
            sessionId: 'bad-version',
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
    const record = (own: IdentityUnit) => ({
        chainId: fixture.chainId,
        writer: { sessionId: current },
        unit: { ...own, from: {} },
    })
    assert.equal(
        await fixture.store.write(BIND_STORES, (tx) => recordOwnSave(tx, record(unit))),
        'marks',
    )
    assert.deepEqual(await snapshot(), before)

    const ownOnly = { ...unit, marks: [{ sessionId: current, seq: 1 }] }
    for (const v of [undefined, 0, 2]) {
        await fixture.store.write(['sessions'], (tx) => tx.put('sessions', { ...row, v }))
        const held = await snapshot()
        assert.equal(
            await fixture.store.write(IDENTITY_STORES, (tx) =>
                commitIdentity(tx, fixture.chainId, ownOnly),
            ),
            false,
        )
        assert.equal(
            await fixture.store.write(BIND_STORES, (tx) => recordOwnSave(tx, record(ownOnly))),
            'unsupported',
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

test('Save completion from a supported older session preserves both sessions and binds its actual source', async () => {
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
    const oldBefore = await fixture.store.read(['sessions'], (tx) => tx.get('sessions', old))
    assert.equal(
        await fixture.store.write(BIND_STORES, (tx) =>
            recordOwnSave(tx, {
                chainId: fixture.chainId,
                writer: { sessionId: current },
                unit: { ...unit, from: {} },
            }),
        ),
        'recorded',
    )
    // Neither session changes: the binding names the older one, and no row is written.
    assert.deepEqual(
        await fixture.store.read(['sessions'], (tx) => tx.get('sessions', current)),
        currentBefore,
    )
    assert.deepEqual(
        await fixture.store.read(['sessions'], (tx) => tx.get('sessions', old)),
        oldBefore,
    )
    const chain = (await fixture.store.read(['chains'], (tx) =>
        tx.get('chains', fixture.chainId),
    )) as { head: string; file: { entry: { sessionId: string } } }
    assert.equal(chain.head, current)
    assert.equal(chain.file.entry.sessionId, old)
})
