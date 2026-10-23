import assert from 'node:assert/strict'
import test from 'node:test'
import { shallowRef } from 'vue'
import { causeOf, createNotStored, NOT_STORED_DELAY_MS } from '../../src/editor/file/notStored'
import type { StorageStatus } from '../../src/local/worker/core'

// The Not stored state (Part 1 §1.6.7): the cause from the storage status alone, shown only
// after it has held for the delay.

const setup = (safe = false) => {
    const status = shallowRef<StorageStatus | undefined>()
    return { status, ...createNotStored({ status, safe }) }
}

test('each storage status gives its cause, and storing gives none', () => {
    assert.equal(causeOf(undefined), undefined)
    assert.equal(causeOf({ mode: 'stored' }), undefined)
    assert.equal(causeOf({ mode: 'stored', mediaPending: ['ab'] }), undefined)
    assert.deepEqual(causeOf({ mode: 'memory' }), { kind: 'unavailable' })
    assert.deepEqual(causeOf({ mode: 'readOnly' }), { kind: 'readOnly' })
    for (const reason of ['full', 'failed', 'upgrading'] as const)
        assert.deepEqual(causeOf({ mode: 'stored', reason }), { kind: 'paused', reason })
    assert.deepEqual(causeOf({ mode: 'memory', reason: 'olderTabs' }), {
        kind: 'paused',
        reason: 'olderTabs',
    })
})

test('a cause shows only after it has held for the delay', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const { status, notStored, notStoredCause } = setup()
    status.value = { mode: 'stored', reason: 'full' }
    assert.deepEqual(notStoredCause.value, { kind: 'paused', reason: 'full' })
    assert.equal(notStored.value, undefined)
    context.mock.timers.tick(NOT_STORED_DELAY_MS - 1)
    assert.equal(notStored.value, undefined)
    context.mock.timers.tick(1)
    assert.deepEqual(notStored.value, { kind: 'paused', reason: 'full' })
})

test('a pause that ends within the delay never shows, and the next one waits afresh', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const { status, notStored } = setup()
    // Each stall is 2 s and the next starts 0.5 s later: the first stall's wait would end in
    // the middle of the second.
    for (let round = 0; round < 3; round++) {
        status.value = { mode: 'stored', reason: 'failed' }
        context.mock.timers.tick(NOT_STORED_DELAY_MS - 1000)
        assert.equal(notStored.value, undefined)
        status.value = { mode: 'stored' }
        context.mock.timers.tick(500)
        assert.equal(notStored.value, undefined)
    }
    status.value = { mode: 'stored', reason: 'failed' }
    context.mock.timers.tick(NOT_STORED_DELAY_MS - 1)
    assert.equal(notStored.value, undefined)
    context.mock.timers.tick(1)
    assert.ok(notStored.value)
})

test('a resume lowers it at once', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const { status, notStored } = setup()
    status.value = { mode: 'stored', reason: 'full' }
    context.mock.timers.tick(NOT_STORED_DELAY_MS)
    assert.ok(notStored.value)
    status.value = { mode: 'stored' }
    assert.equal(notStored.value, undefined)
})

test('a change of reason keeps it shown and reads the current one', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const { status, notStored } = setup()
    status.value = { mode: 'stored', reason: 'failed' }
    context.mock.timers.tick(NOT_STORED_DELAY_MS)
    status.value = { mode: 'stored', reason: 'full' }
    assert.deepEqual(notStored.value, { kind: 'paused', reason: 'full' })
    // A reason that changes while it waits keeps the wait and shows the latest.
    status.value = { mode: 'stored' }
    status.value = { mode: 'stored', reason: 'failed' }
    context.mock.timers.tick(1000)
    status.value = { mode: 'stored', reason: 'full' }
    context.mock.timers.tick(NOT_STORED_DELAY_MS - 1000)
    assert.deepEqual(notStored.value, { kind: 'paused', reason: 'full' })
})

test('a status that changes only in its media does not restart the wait or lower it', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const { status, notStored } = setup()
    status.value = { mode: 'stored', reason: 'full' }
    context.mock.timers.tick(2000)
    status.value = { mode: 'stored', reason: 'full', mediaPending: ['ab'] }
    context.mock.timers.tick(1000)
    assert.ok(notStored.value)
    status.value = { mode: 'stored', reason: 'full' }
    assert.ok(notStored.value)
})

test('safe mode raises nothing, whatever its status says', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const { status, notStored, notStoredCause } = setup(true)
    status.value = { mode: 'readOnly' }
    context.mock.timers.tick(NOT_STORED_DELAY_MS * 2)
    assert.equal(notStoredCause.value, undefined)
    assert.equal(notStored.value, undefined)
})

test('a browser without storage and a newer database show after the delay', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const unavailable = setup()
    unavailable.status.value = { mode: 'memory' }
    const newer = setup()
    newer.status.value = { mode: 'readOnly' }
    context.mock.timers.tick(NOT_STORED_DELAY_MS)
    assert.deepEqual(unavailable.notStored.value, { kind: 'unavailable' })
    assert.deepEqual(newer.notStored.value, { kind: 'readOnly' })
})
