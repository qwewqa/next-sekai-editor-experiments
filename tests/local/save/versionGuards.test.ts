import assert from 'node:assert/strict'
import test from 'node:test'
import { finishOwnSave, BIND_STORES } from '../../../src/local/save/bind'
import { commitIdentity, IDENTITY_STORES, storeMarks, type IdentityUnit } from '../../../src/local/save/commit'
import { futureFixtureOperation } from '../../helpers/historySteps'
import { Fixture } from './fixture'

test('stale Save plans cannot partially mark or bind unsupported session generations', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1, futureFixtureOperation('futureSaveSource', {extra: ['kept']}))
    await fixture.flush()
    const current = fixture.session.id
    const row = await fixture.store.read(['sessions'], tx => tx.get('sessions',current)) as Record<string,unknown>
    const unit: IdentityUnit = {
        clearExport: true,
        docId:'replacement-doc',
        revision:{id:'new-revision',n:1,ancestors:[]},
        file:{name:'new.nxsp',entry:{sessionId:current}},
        marks:[{sessionId:current,seq:1},{sessionId:'old-generation',seq:1}],
    }
    await fixture.store.write(['sessions','entries','chains'], async tx => {
        await tx.put('sessions',{...row,id:'old-generation',v:1})
        await tx.put('entries',{sessionId:'old-generation',seq:1,kept:true,operation:{unknown:'intact'}})
        const chain = await tx.get('chains',fixture.chainId) as Record<string,unknown>
        await tx.put('chains',{...chain,exportName:'keep me'})
    })
    const snapshot = () => fixture.store.read(BIND_STORES, async tx =>
        Promise.all(BIND_STORES.map(store => tx.getAll(store))))
    const before = await snapshot()
    assert.equal(await fixture.store.write(IDENTITY_STORES,tx => storeMarks(tx,unit.marks)),false)
    assert.deepEqual(await snapshot(),before)
    assert.equal(await fixture.store.write(IDENTITY_STORES,tx => commitIdentity(tx,fixture.chainId,unit)),false)
    assert.deepEqual(await snapshot(),before)
    const saveEntry = {sessionId:current,seq:3,time:1234,operation:futureFixtureOperation('futureSave'),snapshot:fixture.head,noteCount:1,revisionId:'new-revision',device:{id:'test',label:'Test'}}
    assert.equal(await fixture.store.write(BIND_STORES,tx => finishOwnSave(tx,fixture.chainId,saveEntry,unit)),false)
    assert.deepEqual(await snapshot(),before)

    const ownOnly = {...unit,marks:[{sessionId:current,seq:1}]}
    for (const v of [undefined,1,3]) {
        await fixture.store.write(['sessions'],tx => tx.put('sessions',{...row,v}))
        const held = await snapshot()
        assert.equal(await fixture.store.write(IDENTITY_STORES,tx => commitIdentity(tx,fixture.chainId,ownOnly)),false)
        assert.equal(await fixture.store.write(BIND_STORES,tx => finishOwnSave(tx,fixture.chainId,saveEntry,ownOnly)),false)
        assert.deepEqual(await snapshot(),held)
    }
    await fixture.store.write(['sessions'],tx => tx.put('sessions',row))
    assert.equal(await fixture.store.write(IDENTITY_STORES,tx => commitIdentity(tx,fixture.chainId,ownOnly)),true)
    const marked = await fixture.store.read(['entries'],tx => tx.get('entries',[current,1])) as {kept:boolean}
    assert.equal(marked.kept,false)
})
