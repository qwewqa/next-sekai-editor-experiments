import assert from 'node:assert/strict'
import test from 'node:test'
import {
    disableFilePicker,
    filePickerRoute,
    setFilePickerChoice,
    type FilePickerChoice,
} from '../../src/platform/filePicker'
import { platform } from '../../src/platform/web'
import { installFakeBrowser } from './fakeBrowser'

// Write to Chosen Files decides `pickSaveFile` and `writeBack` on every read. Runs in its own
// process: the browser and the setting are this file's.
const browser = installFakeBrowser()
Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/156.0.0.0 Safari/537.36',
        maxTouchPoints: 0,
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

test('Auto never uses the save picker, even where the browser has it', () => {
    browser.window.showSaveFilePicker = () => Promise.reject(new Error('Not used'))
    choice = 'auto'
    assert.equal(uses(), false)
    choice = 'disabled'
    assert.equal(uses(), false)
})

test('Enabled uses the save picker where the browser has it', () => {
    browser.window.showSaveFilePicker = () => Promise.reject(new Error('Not used'))
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
    choice = 'enabled'
    assert.equal(filePickerRoute(), 'picker')
    choice = 'auto'
    assert.equal(filePickerRoute(), 'autoDownload')
    choice = 'disabled'
    assert.equal(filePickerRoute(), 'download')
    delete browser.window.showSaveFilePicker
    assert.equal(filePickerRoute(), 'unsupported')
})
