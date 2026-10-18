import assert from 'node:assert/strict'
import test from 'node:test'
import { storageLineKey, type StorageFacts } from '../../src/editor/settings/storageLine'

const facts = (changes: Partial<StorageFacts> = {}): StorageFacts => ({
    unavailable: false,
    privateSuspected: false,
    persisted: false,
    os: 'windows',
    engine: 'chromium',
    standalone: false,
    ...changes,
})

test('the storage line is the first condition that holds', () => {
    assert.equal(storageLineKey(facts()), 'default')
    assert.equal(storageLineKey(facts({ persisted: true })), 'persisted')
    assert.equal(storageLineKey(facts({ os: 'macos', engine: 'webkit' })), 'safari')
    assert.equal(storageLineKey(facts({ os: 'ios', engine: 'webkit' })), 'ios')
    assert.equal(
        storageLineKey(facts({ os: 'ios', engine: 'webkit', standalone: true })),
        'installedWebkit',
    )
    assert.equal(
        storageLineKey(facts({ os: 'macos', engine: 'webkit', standalone: true })),
        'installedWebkit',
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

test('a persisted grant never hides what a tab on iOS or Safari can lose', () => {
    assert.equal(storageLineKey(facts({ persisted: true, os: 'ios', engine: 'webkit' })), 'ios')
    assert.equal(
        storageLineKey(facts({ persisted: true, os: 'macos', engine: 'webkit' })),
        'safari',
    )
})
