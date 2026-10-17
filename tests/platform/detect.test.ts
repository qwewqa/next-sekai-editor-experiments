import assert from 'node:assert/strict'
import test from 'node:test'
import {
    createStandaloneLatch,
    detectFromUa,
    parsePlatformOverride,
    suspectPrivate,
    type UaEnv,
} from '../../src/platform/detect'

const safariMac =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
const chromeWindows =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const env = (userAgent: string, rest: Partial<UaEnv> = {}): UaEnv => ({
    userAgent,
    maxTouchPoints: 0,
    gestureEvent: false,
    ...rest,
})

const samples: [string, UaEnv, ReturnType<typeof detectFromUa>][] = [
    [
        'iPad with a desktop UA',
        env(safariMac, { maxTouchPoints: 5, gestureEvent: true }),
        { engine: 'webkit', os: 'ios' },
    ],
    [
        'iPad',
        env(
            'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
            { maxTouchPoints: 5, gestureEvent: true },
        ),
        { engine: 'webkit', os: 'ios' },
    ],
    [
        'CriOS',
        env(
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0.6312.52 Mobile/15E148 Safari/604.1',
            { maxTouchPoints: 5 },
        ),
        { engine: 'webkit', os: 'ios' },
    ],
    [
        'FxiOS',
        env(
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/124.0 Mobile/15E148 Safari/605.1.15',
            { maxTouchPoints: 5 },
        ),
        { engine: 'webkit', os: 'ios' },
    ],
    ['macOS Safari', env(safariMac, { gestureEvent: true }), { engine: 'webkit', os: 'macos' }],
    ['a Safari UA without WebKit’s GestureEvent', env(safariMac), { engine: 'other', os: 'macos' }],
    [
        'Firefox on Windows',
        env('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0'),
        { engine: 'firefox', os: 'windows' },
    ],
    [
        'Firefox on macOS',
        env('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0'),
        { engine: 'firefox', os: 'macos' },
    ],
    ['Chromium on Windows', env(chromeWindows), { engine: 'chromium', os: 'windows' }],
    [
        'Chrome on macOS',
        env(
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        ),
        { engine: 'chromium', os: 'macos' },
    ],
    ['Edge', env(`${chromeWindows} Edg/124.0.2478.51`), { engine: 'chromium', os: 'windows' }],
    [
        'Chrome on Android',
        env(
            'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
            { maxTouchPoints: 5 },
        ),
        { engine: 'chromium', os: 'android' },
    ],
    [
        'Chromium on Linux',
        env(
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        ),
        { engine: 'chromium', os: 'linux' },
    ],
    [
        'a Chromebook',
        env(
            'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        ),
        { engine: 'chromium', os: 'other' },
    ],
]

for (const [name, sample, expected] of samples) {
    test(`detects ${name}`, () => {
        assert.deepEqual(detectFromUa(sample), expected)
    })
}

const standaloneEnv = () => {
    const env = { displayMode: true, navigator: false, fullscreen: false }
    const latch = createStandaloneLatch({
        displayModeStandalone: () => env.displayMode,
        navigatorStandalone: () => env.navigator,
        fullscreen: () => env.fullscreen,
    })
    return { env, latch }
}

test('the standalone flag is latched at startup', () => {
    const { env, latch } = standaloneEnv()
    assert.equal(latch.get(), true)
    env.displayMode = false
    assert.equal(latch.get(), true)
})

test('the standalone flag is never re-read during fullscreen', () => {
    const { env, latch } = standaloneEnv()
    // display-mode: standalone stops matching in fullscreen.
    env.fullscreen = true
    env.displayMode = false
    latch.reread()
    assert.equal(latch.get(), true)
    env.fullscreen = false
    latch.reread()
    assert.equal(latch.get(), false)
})

test('navigator.standalone counts as standalone', () => {
    const { env, latch } = standaloneEnv()
    env.displayMode = false
    env.navigator = true
    latch.reread()
    assert.equal(latch.get(), true)
})

test('a latch made during fullscreen stays unset until a re-read outside it', () => {
    const env = { fullscreen: true }
    const latch = createStandaloneLatch({
        displayModeStandalone: () => true,
        navigatorStandalone: () => false,
        fullscreen: () => env.fullscreen,
    })
    assert.equal(latch.get(), false)
    env.fullscreen = false
    latch.reread()
    assert.equal(latch.get(), true)
})

test('the platform override keeps only its known fields', () => {
    assert.deepEqual(
        parsePlatformOverride(
            JSON.stringify({
                engine: 'webkit',
                os: 'ios',
                standalone: true,
                persisted: false,
                privateSuspected: true,
                fileSystemAccess: false,
                activation: false,
                extra: 1,
            }),
        ),
        {
            engine: 'webkit',
            os: 'ios',
            standalone: true,
            persisted: false,
            privateSuspected: true,
            fileSystemAccess: false,
            activation: false,
        },
    )
    assert.deepEqual(parsePlatformOverride(JSON.stringify({ engine: 'trident', os: 1 })), {})
    assert.deepEqual(parsePlatformOverride('not json'), {})
    assert.deepEqual(parsePlatformOverride('null'), {})
    assert.deepEqual(parsePlatformOverride(null), {})
})

test('a small quota without persistence suggests a private window', () => {
    assert.equal(suspectPrivate({ persisted: false, quota: 100 * 1024 ** 2 }), true)
    assert.equal(suspectPrivate({ persisted: true, quota: 100 * 1024 ** 2 }), false)
    assert.equal(suspectPrivate({ persisted: false, quota: 50 * 1024 ** 3 }), false)
})
