import { defineConfig } from '@playwright/test'

// NSE_DEV_CSP=1 serves the web policy, and editorFixture.ts fails a spec on a violation.
// Parallel local runs can each choose a free development server port.
const port = process.env.PLAYWRIGHT_PORT ?? '5210'
const timingSpecs = [
    'renderPacing.spec.ts',
    'flushTiming.spec.ts',
    'journalTiming.spec.ts',
    'touchTiming.spec.ts',
    'historyTimingCalendar.spec.ts',
]
// The preview's drawing specs again, with the preview drawn in its worker
// (previewWorker.spec.ts sets each host itself).
const previewHostSpecs = ['preview.spec.ts', 'previewSelection.spec.ts']
const baseURL = `http://127.0.0.1:${port}`
// Which host draws the preview, whatever the setting says.
const previewHost = (value: 'main' | 'worker') => ({
    storageState: {
        cookies: [],
        origins: [{ origin: baseURL, localStorage: [{ name: 'nse.test.previewHost', value }] }],
    },
})

export default defineConfig({
    testDir: './tests/browser',
    testMatch: '**/*.spec.ts',
    fullyParallel: true,
    // More workers don't help: the dev server is the limit. Concurrent runs should pass --workers.
    workers: '25%',
    forbidOnly: !!process.env.CI,
    timeout: 30_000,
    reporter: 'list',
    outputDir: 'test-results',
    use: {
        browserName: 'chromium',
        baseURL,
        viewport: { width: 1600, height: 1000 },
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        launchOptions: {
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
            // Exercise WebGL consistently, including the stale-overlay regression,
            // without requiring a hardware GPU.
            args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        },
    },
    projects: [
        // The specs were written for the main host, which these projects keep; the preview's
        // specs run again in the worker host, the default where the browser can run it.
        { name: 'chromium', testIgnore: timingSpecs, use: previewHost('main') },
        { name: 'chromium-worker', testMatch: previewHostSpecs, use: previewHost('worker') },
        // Measures real frame timing, so it runs alone after the parallel batch.
        // In npx playwright test any chromium failure skips it; npm run test:browser
        // runs it after chromium regardless, and npm run test:timing runs it alone.
        {
            name: 'timing',
            testMatch: timingSpecs,
            use: previewHost('main'),
            dependencies: ['chromium'],
            workers: 1,
            // Its own folder, so running it after chromium keeps chromium's failure output.
            outputDir: 'test-results/timing',
        },
    ],
    webServer: {
        command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
        url: `http://127.0.0.1:${port}`,
        reuseExistingServer: false,
        timeout: 30_000,
    },
})
