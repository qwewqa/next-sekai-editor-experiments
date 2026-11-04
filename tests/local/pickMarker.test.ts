import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
    endPick,
    markPick,
    setMarkerStoreForTests,
    takeUnfinishedPick,
    type MarkerStore,
    type PickMarker,
} from '../../src/local/pickMarker'

// The markers of picks in progress, one per chain: a hint kept from just before a save picker opens
// until its write ends. Storage that fails never stops a pick.

const DAY = 24 * 60 * 60 * 1000

const memoryStore = () => {
    const values = new Map<string, unknown>()
    const store: MarkerStore & { values: Map<string, unknown> } = {
        prepare: () => undefined,
        put: (marker: PickMarker) => {
            values.set(marker.chainId, marker)
        },
        remove: (chainId) => {
            values.delete(chainId)
        },
        get: (chainId) => Promise.resolve(values.get(chainId)),
        sweep: (before) => {
            for (const [key, value] of values)
                if (
                    (value as { at?: unknown }).at === undefined ||
                    (value as PickMarker).at < before
                )
                    values.delete(key)
        },
        values,
    }
    setMarkerStoreForTests(store)
    return store
}

afterEach(() => {
    setMarkerStoreForTests(undefined)
})

test('a pick is marked for its chain until its write ends', () => {
    const store = memoryStore()
    markPick('chain-a', 'save')
    assert.deepEqual(
        { ...(store.values.get('chain-a') as PickMarker), at: 0 },
        { chainId: 'chain-a', surface: 'save', at: 0 },
    )
    endPick('chain-a')
    assert.equal(store.values.size, 0)
})

test("one chain's pick neither replaces nor ends another chain's marker", async () => {
    const store = memoryStore()
    // Tab A is closed while its picker is open; tab B then saves another chain, and dismisses
    // another picker.
    markPick('chain-a', 'save')
    markPick('chain-b', 'export')
    endPick('chain-b')
    markPick('chain-b', 'save')
    endPick('chain-b')
    assert.deepEqual([...store.values.keys()], ['chain-a'])
    assert.equal(await takeUnfinishedPick('chain-b'), undefined)
    assert.equal(await takeUnfinishedPick('chain-a'), 'save')
    assert.equal(await takeUnfinishedPick('chain-a'), undefined)
})

test("a video's marker is read once, as a video", async () => {
    memoryStore()
    markPick('chain-a', 'video')
    assert.equal(await takeUnfinishedPick('chain-a'), 'video')
    assert.equal(await takeUnfinishedPick('chain-a'), undefined)
})

test('a start drops markers over a day old, whatever their chain', async () => {
    const store = memoryStore()
    store.values.set('chain-a', { chainId: 'chain-a', surface: 'save', at: Date.now() - DAY - 1 })
    store.values.set('chain-c', { chainId: 'chain-c', surface: 'save', at: Date.now() - DAY - 1 })
    markPick('chain-b', 'save')
    assert.equal(await takeUnfinishedPick('chain-a'), undefined)
    assert.deepEqual([...store.values.keys()], ['chain-b'])
})

test('a store that throws is ignored: marking, ending and taking never throw', async () => {
    const refused = () => {
        throw new DOMException('Blocked', 'SecurityError')
    }
    setMarkerStoreForTests({
        prepare: refused,
        put: refused,
        remove: refused,
        get: refused,
        sweep: refused,
    })
    assert.doesNotThrow(() => markPick('chain-a', 'save'))
    assert.doesNotThrow(() => endPick('chain-a'))
    assert.equal(await takeUnfinishedPick('chain-a'), undefined)
})

test('a start does not wait long for a store that does not answer', async () => {
    setMarkerStoreForTests({
        prepare: () => undefined,
        put: () => undefined,
        remove: () => undefined,
        get: () => new Promise(() => undefined),
        sweep: () => undefined,
    })
    const began = performance.now()
    assert.equal(await takeUnfinishedPick('chain-a'), undefined)
    assert.ok(performance.now() - began < 3000)
})

test('a marker that is not one is removed and ignored', async () => {
    const store = memoryStore()
    store.values.set('chain-a', { chainId: 5, at: Date.now() })
    assert.equal(await takeUnfinishedPick('chain-a'), undefined)
    assert.equal(store.values.has('chain-a'), false)
})
