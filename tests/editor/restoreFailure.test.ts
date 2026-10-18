import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import {
    damagedEntries,
    peekedInfo,
    requestPeek,
    requestRestore,
} from '../../src/editor/history/selection'
import {
    entryKey,
    isPeeking,
    PeekError,
    resetPeekForTests,
    setPeekEffects,
    setPeekSource,
    type EntryKey,
    type PeekedEntry,
} from '../../src/history/peek'
import { resetStates } from '../../src/history/stack'
import type { State } from '../../src/state'

// A Restore that cannot read its entry (Part 1 §1.4.10.5): the row is marked damaged, as a failed
// peek marks it, so it never fails silently.

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const fake = (name: string) =>
    ({ name, bgm: { offset: 0 }, selectedEntities: [] }) as unknown as State

const key = (seq: number): EntryKey => entryKey('session', seq)

/** Every entry loads, but key 99, which is damaged. */
setPeekSource({
    load: async (k): Promise<PeekedEntry> => {
        await Promise.resolve()
        if (k === key(99)) throw new PeekError('damaged')
        return { state: fake(k), time: 1000 }
    },
    sameSnapshot: () => false,
})

setPeekEffects({
    restoredLabel: (time) => () => `Restored to ${time}`,
    restored: () => undefined,
    alreadyMatches: () => undefined,
})

beforeEach(async () => {
    resetPeekForTests()
    damagedEntries.value = new Set()
    peekedInfo.value = undefined
    await wait(110)
    resetStates({ isDirty: false, name: () => 'live', state: fake('live') })
})

test('restoring an entry that cannot be read marks its row damaged', async () => {
    await requestRestore(key(99))
    assert.deepEqual([...damagedEntries.value], [key(99)])
    assert.equal(isPeeking.value, false)
})

test('a failed Restore of an entry other than the peeked one keeps that peek', async () => {
    requestPeek({ key: key(1), time: 1000, label: 'Life 1' })
    await wait(150)
    await requestRestore(key(99))
    assert.equal(isPeeking.value, true)
    assert.ok(damagedEntries.value.has(key(99)))
    assert.ok(!damagedEntries.value.has(key(1)))
})
