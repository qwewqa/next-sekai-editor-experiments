import { defineConfig, devices } from '@playwright/test'
import config from './playwright.config'
import { AGREED, AGREEMENT_KEY } from './tests/helpers/agreement'

// Parallel local runs can each choose a free preview server port.
// CI runs under xvfb-run, which gives headless Firefox a WebGL2 context.
// CI runs the storage projects (`*-storage`) as jobs of their own, beside the others.
const previewPort = process.env.PLAYWRIGHT_PREVIEW_PORT ?? '5211'
const previewUrl = `http://127.0.0.1:${previewPort}`

// The storage core, which every push runs.
const coreStorageSpecs = [
    'storageHandshake.spec.ts',
    'storageCommitOnUnload.spec.ts',
    'storageWorker.spec.ts',
    'storageFlush.spec.ts',
    // The journal's kill tests: page.close() in Firefox and WebKit.
    'journalKill.spec.ts',
    // Saving where there's no save picker: the download flow.
    'saveDownload.spec.ts',
]
// The slow specs, which browsers-full.yml adds: about 12 of the 18 minutes of Firefox storage.
const slowStorageSpecs = [
    // Startup, the recovery order and the auto save migration.
    'startupSessions.spec.ts',
    // Opening a `.nxsp` and its background import.
    'openProject.spec.ts',
    // The v1 web storage fixtures seeded into a profile and read by the editor.
    'webStorageV1.spec.ts',
]
// NSE_STORAGE_SET=core runs the core alone (check.yml); otherwise all of them, as a local run does.
const storageSpecs =
    process.env.NSE_STORAGE_SET === 'core'
        ? coreStorageSpecs
        : [...coreStorageSpecs, ...slowStorageSpecs]

export default defineConfig({
    ...config,
    testMatch: [
        'playerAudio.spec.ts',
        'waveform.spec.ts',
        'recordVectors.spec.ts',
        'assetSelectGap.spec.ts',
        'openActivation.spec.ts',
    ],
    outputDir: 'test-results-compatibility',
    // Firefox under xvfb sometimes fails to create its first WebGL2 context. A test that passes
    // on a retry is reported as flaky.
    retries: process.env.CI ? 2 : 0,
    // A broken build or an environment fault fails every test; stop after a few instead of retrying all.
    maxFailures: process.env.CI ? 4 : 0,
    use: {
        ...config.use,
        launchOptions: {},
        // As in the main config: no startup guard question unless a spec tests the guard, and the
        // first-visit dialog counts as shown.
        storageState: {
            cookies: [],
            origins: [String(config.use?.baseURL), previewUrl].map((origin) => ({
                origin,
                localStorage: [
                    { name: 'nse.test.noOpeningGuard', value: 'true' },
                    { name: 'sonolus-next-sekai-editor.firstVisitShown', value: '1' },
                    { name: AGREEMENT_KEY, value: AGREED },
                ],
            })),
        },
    },
    projects: [
        { name: 'firefox', use: { browserName: 'firefox' } },
        // Not openActivation.spec.ts: its picker call is showPicker(), which WebKit's chooser event misses.
        {
            name: 'webkit',
            testIgnore: ['openActivation.spec.ts'],
            use: { browserName: 'webkit' },
        },
        // The preview drawn in its worker: its handovers, and its pixels against the main thread's.
        {
            name: 'firefox-preview-worker',
            testMatch: ['previewWorker.spec.ts'],
            use: { browserName: 'firefox' },
        },
        // The storage core: the handshake, commit on unload, the worker's
        // restart and the flush, in each engine. They boot the editor in two tabs, slower here
        // than in Chromium.
        {
            name: 'firefox-storage',
            testMatch: storageSpecs,
            timeout: 60_000,
            use: { browserName: 'firefox' },
        },
        {
            name: 'webkit-storage',
            testMatch: storageSpecs,
            timeout: 60_000,
            use: { browserName: 'webkit' },
        },
        // History's focus, keyboard and scrolling in each engine: the dialog's return, the one roving
        // entry, keys that peek and restore, scroll anchoring and Go To's gap row.
        {
            name: 'firefox-history',
            testMatch: ['historyEngines.spec.ts'],
            timeout: 60_000,
            use: { browserName: 'firefox' },
        },
        {
            name: 'webkit-history',
            testMatch: ['historyEngines.spec.ts'],
            timeout: 60_000,
            use: { browserName: 'webkit' },
        },
        // Firefox-specific keyboard defaults such as quick find and Backspace, and dialog backdrop presses.
        {
            name: 'firefox-chrome',
            testMatch: ['editorChrome.spec.ts', 'shortcuts.spec.ts', 'modalBackdrop.spec.ts'],
            use: { browserName: 'firefox' },
        },
        {
            name: 'firefox-production',
            testDir: './tests/production',
            testMatch: 'browserCompatibility.spec.ts',
            use: { browserName: 'firefox', baseURL: previewUrl },
        },
        {
            name: 'webkit-production',
            testDir: './tests/production',
            testMatch: 'browserCompatibility.spec.ts',
            use: { browserName: 'webkit', baseURL: previewUrl },
        },
        // The release build's classic storage worker under the web policy, its Blob restart and
        // the flush.
        {
            name: 'firefox-production-storage',
            testDir: './tests/production',
            testMatch: ['storageFlush.spec.ts', 'csp.spec.ts'],
            grep: /storage worker|release build/,
            use: { browserName: 'firefox', baseURL: previewUrl },
        },
        {
            name: 'webkit-production-storage',
            testDir: './tests/production',
            testMatch: ['storageFlush.spec.ts', 'csp.spec.ts'],
            grep: /storage worker|release build/,
            use: { browserName: 'webkit', baseURL: previewUrl },
        },
        {
            name: 'mobile-webkit-production',
            testDir: './tests/production',
            testMatch: 'browserCompatibility.spec.ts',
            use: {
                ...devices['iPhone 13'],
                browserName: 'webkit',
                baseURL: previewUrl,
            },
        },
    ],
    webServer: [
        ...(Array.isArray(config.webServer)
            ? config.webServer
            : config.webServer
              ? [config.webServer]
              : []),
        {
            command: `npx vite preview --host 127.0.0.1 --port ${previewPort} --strictPort`,
            url: previewUrl,
            reuseExistingServer: false,
        },
    ],
})
