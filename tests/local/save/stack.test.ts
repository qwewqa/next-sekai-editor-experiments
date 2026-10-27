import assert from 'node:assert/strict'
import test from 'node:test'
import { STACK_CAP } from '../../../src/history/cap'
import { nxspDiskState } from '../../../src/platform/fingerprint'
import { checkStack, Fixture, heldRows, save, sourceOf, stateAt } from './fixture'

// The written undo stack: numbered by replay of the file's own chronology,
// renumbered when sessions before it were removed, the head alone when replay can't follow, and
// at most `STACK_CAP` slots.

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

test("a chain replay can't follow writes the head alone, and says so in the log", async (t) => {
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

test("a chain whose middle session was deleted writes replay's stack, not the session's", async (t) => {
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

test("a Save from the tab's unflushed stack writes its newest 1,000 slots", async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.flush()
    for (let k = 1; k <= STACK_CAP + 10; k++) await fixture.edit(1 + (k % 2))
    // Storing paused: the pending stack has every slot since the session's start.
    const { built, file } = await save(
        fixture,
        { kind: 'copy' },
        { event: 'downloaded', binds: false, extra: { pending: fixture.pending(1) } },
    )
    ok(built)
    assert.ok(file)
    const { undoStack } = (await heldRows(file)).history
    assert.equal(undoStack.slots.length, STACK_CAP)
    assert.equal(undoStack.base, 11)
    assert.equal(undoStack.index, STACK_CAP + 10)
    assert.equal(await checkStack(file), 'replay')
})
