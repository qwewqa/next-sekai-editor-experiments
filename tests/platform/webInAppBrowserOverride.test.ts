import assert from 'node:assert/strict'
import test from 'node:test'
import { PLATFORM_OVERRIDE_KEY, startDetection } from '../../src/platform/detect'
import { platform } from '../../src/platform/web'
import { installFakeBrowser } from './fakeBrowser'

// The override wins over a WebView UA.
installFakeBrowser({ [PLATFORM_OVERRIDE_KEY]: JSON.stringify({ inAppBrowser: false }) })
Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
        userAgent:
            'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.127 Mobile Safari/537.36',
        maxTouchPoints: 5,
    },
})

test('the web platform takes the override over a WebView UA', () => {
    startDetection()
    assert.equal(platform.capabilities.likelyInAppBrowser, false)
})
