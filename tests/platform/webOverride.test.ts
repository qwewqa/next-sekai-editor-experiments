import assert from 'node:assert/strict'
import test from 'node:test'
import { detection, PLATFORM_OVERRIDE_KEY } from '../../src/platform/detect'
import { platform } from '../../src/platform/web'
import { installFakeBrowser } from './fakeBrowser'

// Runs in its own process, so the override is read from this storage.
const browser = installFakeBrowser({
    [PLATFORM_OVERRIDE_KEY]: JSON.stringify({
        engine: 'webkit',
        os: 'ios',
        fileSystemAccess: false,
    }),
})
Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/124.0.0.0', maxTouchPoints: 0 },
})

test('the override sets engine and OS', () => {
    assert.deepEqual(detection(), { engine: 'webkit', os: 'ios' })
    assert.equal(platform.os, 'ios')
    assert.equal(platform.capabilities.unconfirmedDownloads, true)
    assert.equal(platform.diagnostics().engine, 'webkit')
})

test('fileSystemAccess: false turns the save picker off', async () => {
    let picked = false
    browser.window.showSaveFilePicker = () => {
        picked = true
        return Promise.reject(new Error('Not used'))
    }
    const result = await platform.saveFile({
        kind: 'nsld',
        suggestedName: 'LevelData',
        build: () => Promise.resolve(new Blob(['level'])),
    })
    assert.deepEqual(result, { status: 'download-started', name: 'LevelData' })
    assert.equal(picked, false)
    assert.equal(platform.capabilities.writeBack, false)
})
