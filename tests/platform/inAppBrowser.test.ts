import { devices } from '@playwright/test'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { UaEnv } from '../../src/platform/detect'
import { HOST_GLOBALS, looksLikeInAppBrowser } from '../../src/platform/inAppBrowser'
import { createMockPlatform } from '../../src/platform/mock'
import { platform as nativePlatform } from '../../src/platform/native'

// The fixtures are user agents from ua-parser-js, Matomo device-detector and inapp-spy, read on
// 2026-10-19. None is a capture from a device.

const env = (userAgent: string, rest: Partial<UaEnv> = {}): UaEnv => ({
    userAgent,
    maxTouchPoints: 0,
    gestureEvent: false,
    ...rest,
})

const ANDROID_WV =
    'Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.000 Mobile Safari/537.36'
const ANDROID_CHROME =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.83 Mobile Safari/537.36'
const IOS =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)'
const IOS_SAFARI = `${IOS} Version/18.6 Mobile/15E148 Safari/604.1`
const MAC_SAFARI =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
const MAC_WEBKIT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'

type Case = [name: string, ua: string, rest?: Partial<UaEnv>]

const flagged: Case[] = [
    ['Android WebView', ANDROID_WV],
    [
        'Android WebView, Pixel 8',
        'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.127 Mobile Safari/537.36',
    ],
    ['Facebook, Android', `${ANDROID_CHROME} [FB_IAB/FB4A;FBAV/488.0.0.62.79;IABMV/1;]`],
    [
        'Facebook, iOS (old shape)',
        `${IOS} Mobile/22B83 [FBAN/FBIOS;FBAV/488.0.0.68.101;FBBV/658219612;FBDV/iPhone12,8;FBMD/iPhone;FBSN/iOS;FBSV/18.1;FBSS/2;FBID/phone;FBLC/en_US;FBOP/5;FBRV/0;IABMV/1]`,
    ],
    ['Facebook, iOS (MetaIAB, with Safari/)', `${IOS} Mobile/22G100 Safari/604.1 MetaIAB Facebook`],
    [
        'Facebook, iOS (WebKit/ without AppleWebKit/)',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) WebKit/8612 (KHTML, like Gecko) Mobile/22B83 [FBAN/FBIOS;FBAV/488.0.0.68.101]',
    ],
    ['Messenger, Android', `${ANDROID_CHROME} [FB_IAB/MESSENGER;FBAV/118.0.0.30.109;]`],
    [
        'Instagram, Android',
        `${ANDROID_CHROME} Instagram 355.1.0.44.103 Android (34/14; 420dpi; 1080x2400; samsung; SM-S911B; dm1q; qcom; en_US; 658226503)`,
    ],
    [
        'Instagram, iOS (with Safari/ at the end)',
        `${IOS} Mobile/22F76 Instagram 393.1.0.36.70 (iPhone15,3; iOS 18_5; en_US; en; scale=3.00; 1290x2796; IABMV/1; 776538208) Safari/604.1)`,
    ],
    [
        'Threads, iOS',
        `${IOS} Mobile/23D8133 Barcelona 379.0.0.26.99 (iPhone18,5; iOS 26_3_1; en_US; en; scale=3.00; 1206x2622; IABMV/1; 882345123)`,
    ],
    ['Threads, iOS (with Safari/)', `${IOS_SAFARI} Barcelona 379.0.0.26.99`],
    ['LINE, Android', `${ANDROID_CHROME} Line/14.18.1/IAB`],
    ['LINE, iOS', `${IOS} Mobile/12D508 Safari Line/5.9.5`],
    [
        'WeChat, Android',
        `${ANDROID_CHROME} XWEB/1460217 MMWEBSDK/20260502 MMWEBID/2514 MicroMessenger/8.0.74.3120(0x28004A3A) WeChat/arm64 Weixin NetType/WIFI Language/en ABI/arm64`,
    ],
    ['WeChat, iOS', `${IOS} Mobile/14D27 MicroMessenger/6.5.8 NetType/WIFI Language/zh_CN`],
    [
        'WeChat, Windows (token only)',
        'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/39.0.2171.95 Safari/537.36 MicroMessenger/6.5.2.501 NetType/WIFI WindowsWechat QBCore/3.43.901.400 QQBrowser/9.0.2524.400',
    ],
    ['KakaoTalk, Android', `${ANDROID_CHROME};KAKAOTALK 2309520`],
    ['KakaoTalk, iOS', `${IOS} Mobile/15E148 KAKAOTALK 8.6.3`],
    [
        'TikTok, Android',
        `${ANDROID_CHROME} musical_ly_2023303040 JsSdk/1.0 NetType/WIFI Channel/googleplay AppName/musical_ly app_version/30.3.4 ByteLocale/en BytedanceWebview/d8a21c6`,
    ],
    ['TikTok, iOS (with Safari/)', `${IOS_SAFARI} musical_ly_41.9.0`],
    [
        'Snapchat, iOS (like Safari/)',
        `${IOS} Version/17.3.1 Mobile/15E148 Snapchat/12.72.0.39 (like Safari/8617.2.4.10.8, panda)`,
    ],
    [
        'Snapchat, Android (no word boundary)',
        'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36Snapchat11.59.0.35 (SM-S911B; Android 14#abc#34; gzip)',
    ],
    ['LinkedIn, Android', `${ANDROID_CHROME} [LinkedInApp]/2.200.63`],
    ['LinkedIn, iOS', `${IOS} Mobile/15E148 [LinkedInApp]/9.30.1753`],
    [
        'QQ, iOS',
        `${IOS} Mobile/15E148 QQ/9.0.17.638 V1_IPH_SQ_9.0.17_1_APP_A Pixel/1290 Core/WKWebView Device/Apple(iPhone 15) NetType/WIFI QBWebViewType/1`,
    ],
    [
        'Weibo, Android',
        `${ANDROID_CHROME} Weibo (HUAWEI-HUAWEI MLA-AL10__weibo__9.4.3__android__android6.0)`,
    ],
    [
        'NAVER, iOS (with Safari/)',
        `${IOS} Version/17.2 Mobile/15E148 Safari/605.1 NAVER(inapp; search; 1010; 11.17.1; SE3)`,
    ],
    [
        'NAVER, Android',
        'Mozilla/5.0 (Linux; Android 9; SM-G960N) AppleWebKit/537.36 (KHTML, like Gecko) Whale/1.0.0.0 Crosswalk/26.90.3.16 Mobile Safari/537.36 NAVER(inapp; search; 1000; 11.10.5)',
    ],
    [
        'Zalo, Android (no wv)',
        'Mozilla/5.0 (Linux; Android 16; SM-A576U1 Build/BP4A.251205.006;) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.199 Mobile Safari/537.36 Zalo android/260801903 ZaloTheme/light ZaloLanguage/en',
    ],
    [
        'WhatsApp, Android (no wv)',
        'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.124 Mobile Safari/537.36 [WA4A/2.25.32.75;]',
    ],
    [
        'WhatsApp, iOS (with Safari/)',
        `${IOS} Version/26.0.1 Mobile/15E148 Safari/604.1 [WAiOS/2.25.31]`,
    ],
    ['Reddit, Android', `${ANDROID_CHROME} Reddit/Version 2026.23.0/Build 2623040/Android 15`],
    ['Pinterest, Android', `${ANDROID_CHROME} [Pinterest/Android]`],
    ['X, iOS (with Safari/)', `${IOS_SAFARI} Twitter for iPhone/10.34`],
    ['X, Android', `${ANDROID_CHROME} TwitterAndroid`],
    ['Yahoo! Japan, iOS (with Safari/)', `${IOS_SAFARI} YJApp-IOS jp.co.yahoo.ipn.appli/4.131.0`],
    [
        'Discord desktop (Electron)',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) discord/0.0.26 Chrome/108.0.5359.215 Electron/22.3.2 Safari/537.36',
    ],
    ['Discord native client, iOS', 'Discord/52.0 (iPad; iOS 14.4; Scale/2.00)'],
    ['plain iOS WKWebView', `${IOS} Mobile/15E148`],
    ['iPad WKWebView with a desktop UA', MAC_WEBKIT, { maxTouchPoints: 5 }],
]

const notFlagged: Case[] = [
    ['Chrome, Android', ANDROID_CHROME],
    [
        'Samsung Internet, Android',
        'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36',
    ],
    ['Firefox, Android', 'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0'],
    ['Edge, Android', `${ANDROID_CHROME} EdgA/130.0.2849.48`],
    [
        'MQQBrowser, Android',
        'Mozilla/5.0 (Linux; U; Android 9; zh-cn; MI 8 Build/PKQ1.180729.001) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/66.0.3359.126 MQQBrowser/9.6 Mobile Safari/537.36',
    ],
    // Custom Tabs, Trusted Web Activities and Discord's Android in-app view send the browser's UA.
    ['Chrome Custom Tab (the Chrome UA)', ANDROID_CHROME],
    ['Safari, iPhone', IOS_SAFARI],
    // Its UA is Safari's; only a probe, which is not used, could tell it apart.
    ['SFSafariViewController (the Safari UA)', IOS_SAFARI],
    ['Chrome, iPhone', `${IOS} CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1`],
    ['Firefox, iPhone (double space)', `${IOS} FxiOS/130.1  Mobile/15E148 Safari/605.1.15`],
    ['Edge, iPhone', `${IOS} Version/18.0 EdgiOS/130.0.2849.80 Mobile/15E148 Safari/605.1.15`],
    ['Yandex, iPhone', `${IOS} Version/18.0 YaBrowser/24.10.0.1234.10 Mobile/15E148 Safari/604.1`],
    ['Opera, iPhone', `${IOS} Version/18.0 OPT/5.0.7 Mobile/15E148 Safari/604.1`],
    ['iPad Safari with a desktop UA', MAC_SAFARI, { maxTouchPoints: 5 }],
    ['Safari, macOS', MAC_SAFARI],
    [
        'Chrome, Windows',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ],
    [
        'Edge, Windows',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
    ],
    [
        'Firefox, Linux',
        'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
    ],
    [
        'HeadlessChrome',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/124.0.0.0 Safari/537.36',
    ],
    [
        'Discordbot, the crawler',
        'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    ],
    // The shape of Tauri on macOS: WebKit with no Safari/ on a Mac that has no touch screen.
    ['macOS WKWebView with no touch', MAC_WEBKIT],
    ['Node (no user agent)', ''],
]

for (const [name, ua, rest] of flagged)
    test(`flags ${name}`, () => {
        assert.equal(looksLikeInAppBrowser(env(ua, rest), false), true, ua)
    })

for (const [name, ua, rest] of notFlagged)
    test(`leaves ${name} alone`, () => {
        assert.equal(looksLikeInAppBrowser(env(ua, rest), false), false, ua)
    })

test('flags Telegram by the globals it injects, whatever the UA says', () => {
    assert.equal(looksLikeInAppBrowser(env(IOS_SAFARI), false), false)
    assert.equal(looksLikeInAppBrowser(env(IOS_SAFARI), false, true), true)
    assert.equal(looksLikeInAppBrowser(env(ANDROID_CHROME), false, true), true)
    assert.deepEqual(
        [...HOST_GLOBALS],
        ['TelegramWebview', 'TelegramWebviewProxy', 'TelegramWebviewProxyProto'],
    )
})

test('a Home Screen web app is never flagged, whatever its UA or globals', () => {
    for (const ua of [
        `${IOS} Mobile/15E148`,
        ANDROID_WV,
        `${IOS} Mobile/15E148 Instagram 346.0.0.24`,
    ])
        for (const hostGlobals of [false, true])
            assert.equal(looksLikeInAppBrowser(env(ua), true, hostGlobals), false)
})

test('no Playwright device descriptor is flagged', () => {
    const names = Object.keys(devices)
    assert.ok(names.length > 100)
    for (const name of names) {
        const device = devices[name]
        assert.ok(device)
        assert.equal(
            looksLikeInAppBrowser(
                env(device.userAgent, { maxTouchPoints: device.hasTouch ? 5 : 0 }),
                false,
            ),
            false,
            `${name}: ${device.userAgent}`,
        )
    }
})

test('the apps never show it: the native capability is false whatever the UA', () => {
    // Tauri on Android hosts the system WebView, whose UA carries `; wv)`: the rule alone would flag it.
    assert.equal(looksLikeInAppBrowser(env(ANDROID_WV), false), true)
    assert.equal(nativePlatform.capabilities.likelyInAppBrowser, false)
})

test('the mock platform does not flag by default, and can be told to', () => {
    assert.equal(createMockPlatform().capabilities.likelyInAppBrowser, false)
    assert.equal(createMockPlatform({ kind: 'native' }).capabilities.likelyInAppBrowser, false)
    assert.equal(
        createMockPlatform({ capabilities: { likelyInAppBrowser: true } }).capabilities
            .likelyInAppBrowser,
        true,
    )
})
