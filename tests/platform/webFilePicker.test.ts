import assert from 'node:assert/strict'
import test from 'node:test'
import {
    disableFilePicker,
    filePickerRoute,
    setFilePickerChoice,
    type FilePickerChoice,
    type UaData,
} from '../../src/platform/filePicker'
import { platform } from '../../src/platform/web'
import { installFakeBrowser } from './fakeBrowser'

// Write to Chosen Files decides `pickSaveFile` and `writeBack` on every read. Runs in its own
// process: the browser, its client hints and the setting are this file's.
const browser = installFakeBrowser()
let uaData: UaData | undefined
Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/156.0.0.0 Safari/537.36',
        maxTouchPoints: 0,
        get userAgentData() {
            return uaData
        },
    },
})
let choice: FilePickerChoice = 'auto'
setFilePickerChoice(
    () => choice,
    () => {
        choice = 'disabled'
    },
)

const uses = () => {
    const picks = !!platform.pickSaveFile
    assert.equal(platform.capabilities.writeBack, picks)
    return picks
}

test('with the save picker, Auto uses it on desktop, Disabled never and Enabled always', () => {
    browser.window.showSaveFilePicker = () => Promise.reject(new Error('Not used'))
    uaData = { platform: 'Windows', brands: [{ brand: 'Google Chrome', version: '156' }] }
    choice = 'auto'
    assert.equal(uses(), true)
    choice = 'disabled'
    assert.equal(uses(), false)
    choice = 'enabled'
    assert.equal(uses(), true)
})

test('Auto on Android uses it only from Google Chrome 151, and Enabled overrides that', () => {
    browser.window.showSaveFilePicker = () => Promise.reject(new Error('Not used'))
    choice = 'auto'
    uaData = { platform: 'Android', brands: [{ brand: 'Google Chrome', version: '150' }] }
    assert.equal(uses(), false)
    uaData = { platform: 'Android', brands: [{ brand: 'Google Chrome', version: '151' }] }
    assert.equal(uses(), true)
    uaData = { platform: 'Android', brands: [{ brand: 'Samsung Internet', version: '30' }] }
    assert.equal(uses(), false)
    choice = 'enabled'
    assert.equal(uses(), true)
})

test('disabling it through the platform sets the setting', () => {
    browser.window.showSaveFilePicker = () => Promise.reject(new Error('Not used'))
    choice = 'enabled'
    disableFilePicker()
    assert.equal(choice, 'disabled')
    assert.equal(uses(), false)
})

test('without the save picker nothing uses it, whatever the setting', () => {
    delete browser.window.showSaveFilePicker
    for (const each of ['auto', 'enabled', 'disabled'] as const) {
        choice = each
        assert.equal(uses(), false)
    }
})

test('the visit records which way saves go', () => {
    browser.window.showSaveFilePicker = () => Promise.reject(new Error('Not used'))
    uaData = { platform: 'Windows', brands: [{ brand: 'Google Chrome', version: '156' }] }
    choice = 'auto'
    assert.equal(filePickerRoute(), 'picker')
    choice = 'disabled'
    assert.equal(filePickerRoute(), 'download')
    choice = 'auto'
    uaData = { platform: 'Android', brands: [{ brand: 'Google Chrome', version: '150' }] }
    assert.equal(filePickerRoute(), 'autoDownload')
    delete browser.window.showSaveFilePicker
    assert.equal(filePickerRoute(), 'unsupported')
})
