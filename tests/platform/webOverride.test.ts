import assert from 'node:assert/strict'
import test from 'node:test'
import { gzip } from 'pako'
import { detection, PLATFORM_OVERRIDE_KEY } from '../../src/platform/detect'
import { platform } from '../../src/platform/web'
import { installFakeBrowser } from './fakeBrowser'

// Runs in its own process, so the override is read from this storage.
const browser = installFakeBrowser({
    [PLATFORM_OVERRIDE_KEY]: JSON.stringify({
        engine: 'webkit',
        os: 'ios',
        fileSystemAccess: false,
        activation: false,
    }),
})
Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/124.0.0.0', maxTouchPoints: 0 },
})

const level = () => Promise.resolve(new Blob([gzip(JSON.stringify({ entities: [] }))]))

test('the override sets engine and OS', () => {
    assert.deepEqual(detection(), { engine: 'webkit', os: 'ios' })
    assert.equal(platform.os, 'ios')
    assert.equal(platform.capabilities.closePrompt, false)
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
        build: level,
    })
    assert.deepEqual(result, { status: 'download-started', name: 'LevelData' })
    assert.equal(picked, false)
    assert.equal(platform.capabilities.writeBack, false)
})

test('on iOS a download link opens a new context, so an ignored download never replaces the page', () => {
    // A Home Screen web app whose WebKit ignores `download` would otherwise navigate the editor.
    assert.ok(browser.downloads.length > 0)
    for (const { target } of browser.downloads) assert.equal(target, '_blank')
})

test('a build that outlasted the gesture asks for a new tap before downloading', async () => {
    browser.downloads.length = 0
    const asked: unknown[] = []
    const cancelled = await platform.saveFile({
        kind: 'nsld',
        suggestedName: 'LevelData.nsld',
        build: level,
        ready: (file) => {
            asked.push(file)
            return Promise.resolve(false)
        },
    })
    assert.deepEqual(cancelled, { status: 'cancelled' })
    assert.equal(browser.downloads.length, 0)

    const started = await platform.saveFile({
        kind: 'nsld',
        suggestedName: 'LevelData.nsld',
        build: level,
        ready: (file) => {
            asked.push(file)
            return Promise.resolve(true)
        },
    })
    assert.deepEqual(started, { status: 'download-started', name: 'LevelData.nsld' })
    assert.equal(browser.downloads.length, 1)
    const size = (await level()).size
    assert.deepEqual(asked, [
        { name: 'LevelData.nsld', size },
        { name: 'LevelData.nsld', size },
    ])
})
