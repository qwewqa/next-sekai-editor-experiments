import assert from 'node:assert/strict'
import test from 'node:test'
import { readReplaceDecision } from '../../../src/local/save/predicate'
import { nxspDiskState } from '../../../src/platform/fingerprint'
import { Fixture, heldRows, inspectNxsp, save, sourceOf } from './fixture'

// A save picker returning the chain's own file (Part 1 §1.4.7 R2, R4; owner decision log D5;
// `work/d5/safety.md` S1, S2): the file is read first only when storage lacks what it holds (the
// Replace guard's test), and then appended to, so nothing is lost; with the read declined it is
// written from storage, and the write says "Some earlier steps were not kept.".

const diskOf = (file: File) => nxspDiskState(file, file.lastModified).then((disk) => ({ ...disk }))

const needsRead = async (fixture: Fixture, file: File) => {
    const disk = await nxspDiskState(file, file.lastModified)
    const { projectJson } = await inspectNxsp(file, {
        token: 'pick',
        role: 'target',
        fingerprint: disk.fingerprint,
    })
    return (
        await readReplaceDecision(fixture.store, fixture.chainId, projectJson, disk.fingerprint)
    )?.holdsBase
}

const chainWithFile = async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.edit(2)
    // Undone and replaced: state 2 leaves the stack, so cleanup can take it.
    fixture.undo()
    await fixture.edit(3)
    await fixture.flush()
    const first = await save(fixture, { kind: 'copy' }, { disk: diskOf })
    assert.ok(first.file)
    await fixture.edit(4)
    await fixture.flush()
    return { fixture, file: first.file }
}

test('storage holding everything: no read, and the self-pick written from storage loses nothing', async () => {
    const { fixture, file } = await chainWithFile()
    assert.equal(await needsRead(fixture, file), false)
    const { built, file: written } = await save(fixture, { kind: 'copy' }, { disk: diskOf })
    assert.ok(!('refused' in built) && written)
    assert.equal(built.someStepsNotKept, false)
    const old = (await heldRows(file)).rows
    const now = (await heldRows(written)).rows
    for (const [row, count] of old) assert.ok((now.get(row) ?? 0) >= count, row)
})

test('storage short: the file is read first and appended to; declined, the line shows', async () => {
    const { fixture, file } = await chainWithFile()
    await fixture.flush()
    assert.ok(await fixture.thin(0, 2))
    assert.equal(await needsRead(fixture, file), true)

    // Read first: an append to the bytes read, every row of the file kept.
    const appended = await save(
        fixture,
        { kind: 'append', source: 'target' },
        { files: [await sourceOf(file)], disk: diskOf, binds: false },
    )
    assert.ok(!('refused' in appended.built) && appended.file)
    assert.equal(appended.built.someStepsNotKept, false)
    const old = (await heldRows(file)).rows
    const now = (await heldRows(appended.file)).rows
    for (const [row, count] of old) assert.ok((now.get(row) ?? 0) >= count, row)

    // The read declined: written from storage, and the write says so.
    const declined = await save(fixture, { kind: 'copy' }, { disk: diskOf, binds: false })
    assert.ok(!('refused' in declined.built))
    assert.equal(declined.built.someStepsNotKept, true)
})
