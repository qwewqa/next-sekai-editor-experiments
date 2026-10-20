import assert from 'node:assert/strict'
import test from 'node:test'
import { startDetection } from '../../src/platform/detect'
import { platform } from '../../src/platform/web'
import { installFakeBrowser } from './fakeBrowser'

// Runs in its own process, so the detection latches here: a WebView UA, and Telegram's globals on
// a plain one in webInAppBrowserTelegram.test.ts, and the override in webInAppBrowserOverride.test.ts.
installFakeBrowser()
Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
        userAgent:
            'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.127 Mobile Safari/537.36',
        maxTouchPoints: 5,
    },
})

test('the web platform flags an Android WebView UA at startup', () => {
    startDetection()
    assert.equal(platform.capabilities.likelyInAppBrowser, true)
})
