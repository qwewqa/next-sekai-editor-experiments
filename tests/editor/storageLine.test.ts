import assert from 'node:assert/strict'
import test from 'node:test'
import {
    storageLineKey,
    storageUnavailable,
    type StorageFacts,
} from '../../src/editor/settings/storageLine'

const facts = (changes: Partial<StorageFacts> = {}): StorageFacts => ({
    unavailable: false,
    privateSuspected: false,
    inAppBrowser: false,
    os: 'windows',
    engine: 'chromium',
    standalone: false,
    ...changes,
})

test('the storage line is the first condition that holds', () => {
    assert.equal(storageLineKey(facts()), undefined)
    assert.equal(storageLineKey(facts({ os: 'macos', engine: 'webkit' })), 'safari')
    assert.equal(storageLineKey(facts({ os: 'ios', engine: 'webkit' })), 'ios')
    assert.equal(
        storageLineKey(facts({ os: 'ios', engine: 'webkit', standalone: true })),
        undefined,
    )
    assert.equal(
        storageLineKey(facts({ os: 'macos', engine: 'webkit', standalone: true })),
        undefined,
    )
    assert.equal(
        storageLineKey(facts({ privateSuspected: true, os: 'ios', engine: 'webkit' })),
        'private',
    )
    assert.equal(
        storageLineKey(facts({ unavailable: true, privateSuspected: true })),
        'unavailable',
    )
})

test("an app's built-in browser beats the browser lines, and loses to unavailable and private", () => {
    const inApp = { inAppBrowser: true }
    assert.equal(storageLineKey(facts(inApp)), 'inAppBrowser')
    assert.equal(storageLineKey(facts({ ...inApp, os: 'ios', engine: 'webkit' })), 'inAppBrowser')
    assert.equal(storageLineKey(facts({ ...inApp, os: 'macos', engine: 'webkit' })), 'inAppBrowser')
    assert.equal(storageLineKey(facts({ ...inApp, privateSuspected: true })), 'private')
    assert.equal(storageLineKey(facts({ ...inApp, unavailable: true })), 'unavailable')
})

test('the line describes the browser: safe mode\'s read-only open and a wait on older tabs are not "cannot store"', () => {
    // No storage at all, and a database from a newer build, are.
    assert.equal(storageUnavailable({ mode: 'memory' }, false), true)
    assert.equal(storageUnavailable({ mode: 'readOnly' }, false), true)
    // Safe mode opens read-only on purpose; the browser itself stores.
    assert.equal(storageUnavailable({ mode: 'readOnly' }, true), false)
    // An upgrade held by older tabs runs in memory for now; the not-stored line says why.
    assert.equal(storageUnavailable({ mode: 'memory', reason: 'olderTabs' }, false), false)
    assert.equal(storageUnavailable({ mode: 'stored' }, false), false)
    assert.equal(storageUnavailable({ mode: 'stored', reason: 'full' }, false), false)
})
