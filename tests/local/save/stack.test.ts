import assert from 'node:assert/strict'
import test from 'node:test'
import { nxspDiskState } from '../../../src/platform/fingerprint'
import { checkStack, Fixture, save, sourceOf, stateAt } from './fixture'

// The written undo stack (§1.6.11.5, §1.3.9): numbered by replay of the file's own chronology,
// renumbered when sessions before it were removed, and the head alone when replay can't follow.

const diskOf = (file: File) => nxspDiskState(file, file.lastModified).then((disk) => ({ ...disk }))

const ok = <T extends object>(value: T) => {
    assert.ok(!('refused' in value), JSON.stringify(value))
    return value as Exclude<T, { refused: string }>
}

test('a chain whose first session was deleted is renumbered from its own first entry', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.flush()
    await fixture.start()
    await fixture.edit(2)
    await fixture.flush()
    await fixture.deleteSession(0)
    const { built, file } = await save(fixture, { kind: 'copy' }, { event: 'downloaded' })
    ok(built)
    assert.ok(file)
    assert.equal(await checkStack(file), 'replay')
})

test('a chain replay can’t follow writes the head alone, and says so in the log', async (t) => {
    const warn = t.mock.method(console, 'warn', () => undefined)
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.edit(2)
    await fixture.flush()
    await fixture.start()
    // Undo onto a slot the deleted session made.
    fixture.undo()
    await fixture.flush()
    await fixture.deleteSession(0)
    const { built, file } = await save(fixture, { kind: 'copy' }, { event: 'downloaded' })
    ok(built)
    assert.ok(file)
    assert.equal(await checkStack(file), 'head')
    assert.equal(warn.mock.callCount(), 1)
})

test('write-backs after deleted sessions keep a stack replay defines', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.flush()
    const first = await save(fixture, { kind: 'copy' }, { disk: diskOf })
    ok(first.built)
    assert.ok(first.file)
    await fixture.start()
    await fixture.edit(2)
    fixture.undo()
    await fixture.edit(3)
    await fixture.flush()
    await fixture.deleteSession(0)
    const { built, file } = await save(
        fixture,
        { kind: 'append', source: 'target' },
        { files: [await sourceOf(first.file)], disk: diskOf },
    )
    ok(built)
    assert.ok(file)
    assert.equal(await checkStack(file), 'replay')
    assert.equal(stateAt(3).hex, ok(built).saveEntry.snapshot)
})

test('a chain whose middle session was deleted writes replay’s stack, not the session’s', async (t) => {
    t.mock.method(console, 'warn', () => undefined)
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.flush()
    await fixture.start()
    await fixture.edit(1)
    await fixture.flush()
    await fixture.start()
    // The same state as the first session's: replay follows, with another stack.
    await fixture.edit(0)
    await fixture.flush()
    await fixture.deleteSession(1)
    const { built, file } = await save(fixture, { kind: 'copy' }, { event: 'downloaded' })
    ok(built)
    assert.ok(file)
    assert.equal(await checkStack(file), 'replay')
})
