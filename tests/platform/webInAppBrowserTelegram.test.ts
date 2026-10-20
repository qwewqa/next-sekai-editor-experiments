import assert from 'node:assert/strict'
import test from 'node:test'
import { startDetection } from '../../src/platform/detect'
import { platform } from '../../src/platform/web'
import { installFakeBrowser } from './fakeBrowser'

// Telegram Android can show a plain Chrome UA; it injects these globals into the page.
const browser = installFakeBrowser()
Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
        userAgent:
            'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.6668.100 Mobile Safari/537.36',
        maxTouchPoints: 5,
    },
})
;(browser.window as unknown as Record<string, unknown>).TelegramWebviewProxy = {}

test('the web platform flags Telegram by its injected globals', () => {
    startDetection()
    assert.equal(platform.capabilities.likelyInAppBrowser, true)
})
