import assert from 'node:assert/strict'
import test from 'node:test'
import { autoAllowsPicker, type AutoEnv } from '../../src/platform/filePicker'

const chrome = (version: string) => [
    { brand: 'Google Chrome', version },
    { brand: 'Chromium', version },
    { brand: 'Not)A;Brand', version: '24' },
]

const phone = { uaAndroid: true, uaLinux: false, maxTouchPoints: 5 }
// Chrome for Android's desktop site, as the Android 15 emulator reported it.
const desktopSite = { uaAndroid: false, uaLinux: true, maxTouchPoints: 5 }

const cases: [string, AutoEnv, boolean][] = [
    [
        'Chrome 149 on Android',
        { data: { platform: 'Android', brands: chrome('149') }, ...phone },
        false,
    ],
    [
        'Chrome 150 on Android',
        { data: { platform: 'Android', brands: chrome('150') }, ...phone },
        false,
    ],
    [
        'Chrome 151 on Android',
        { data: { platform: 'Android', brands: chrome('151') }, ...phone },
        true,
    ],
    [
        'Chrome 156 on Android',
        { data: { platform: 'Android', brands: chrome('156') }, ...phone },
        true,
    ],
    [
        'Samsung Internet on Android',
        {
            data: {
                platform: 'Android',
                brands: [
                    { brand: 'Samsung Internet', version: '30' },
                    { brand: 'Chromium', version: '143' },
                ],
            },
            ...phone,
        },
        false,
    ],
    [
        'Edge on Android',
        {
            data: {
                platform: 'Android',
                brands: [
                    { brand: 'Microsoft Edge', version: '156' },
                    { brand: 'Chromium', version: '156' },
                ],
            },
            ...phone,
        },
        false,
    ],
    [
        'Android WebView',
        {
            data: { platform: 'Android', brands: [{ brand: 'Android WebView', version: '156' }] },
            ...phone,
        },
        false,
    ],
    ['an Android UA without client hints', { data: undefined, ...phone }, false],
    [
        'Chrome 149 desktop site on Android',
        { data: { platform: 'Linux', brands: chrome('149') }, ...desktopSite },
        false,
    ],
    [
        'Chrome 156 desktop site on Android',
        { data: { platform: 'Linux', brands: chrome('156') }, ...desktopSite },
        true,
    ],
    [
        'Chromium on a Linux desktop without touch',
        {
            data: { platform: 'Linux', brands: [{ brand: 'Chromium', version: '140' }] },
            uaAndroid: false,
            uaLinux: true,
            maxTouchPoints: 0,
        },
        true,
    ],
    [
        'Chromium on a Linux touch screen (the accepted cost)',
        {
            data: { platform: 'Linux', brands: [{ brand: 'Chromium', version: '140' }] },
            uaAndroid: false,
            uaLinux: true,
            maxTouchPoints: 10,
        },
        false,
    ],
    [
        'Edge on a Windows touch laptop',
        {
            data: { platform: 'Windows', brands: [{ brand: 'Microsoft Edge', version: '140' }] },
            uaAndroid: false,
            uaLinux: false,
            maxTouchPoints: 10,
        },
        true,
    ],
    [
        'Chrome on ChromeOS',
        {
            data: { platform: 'Chrome OS', brands: chrome('140') },
            uaAndroid: false,
            uaLinux: false,
            maxTouchPoints: 10,
        },
        true,
    ],
    [
        'Chrome on macOS',
        {
            data: { platform: 'macOS', brands: chrome('120') },
            uaAndroid: false,
            uaLinux: false,
            maxTouchPoints: 0,
        },
        true,
    ],
]

for (const [name, env, allowed] of cases)
    test(`Auto ${allowed ? 'uses' : 'does not use'} the picker: ${name}`, () => {
        assert.equal(autoAllowsPicker(env), allowed)
    })
