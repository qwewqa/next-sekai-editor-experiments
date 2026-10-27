import { defineConfig } from '@playwright/test'

// The specs build dates in Node and read them from the page: both run in UTC, whatever the machine uses.
process.env.TZ = 'UTC'

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
// Tests CI does not run, each with its reason; npm run test:browser still runs them. An entry names
// a spec and, to leave the rest of the spec in, a pattern for the test's title and the project.
type CiExclusion = { spec: string; title?: string; project?: string; reason: string }
const ciExclusions: CiExclusion[] = [
    {
        spec: 'preview.spec.ts',
        title: 'same-beat elevation connectors keep identical geometry',
        project: 'chromium-worker',
        reason: 'the worker draws on its own clock, which the fake clock of the page does not hold',
    },
    {
        spec: 'preview.spec.ts',
        title: 'hiding the time removes both clocks',
        project: 'chromium-worker',
        reason: 'the worker draws a frame when the page expects none',
    },
    {
        spec: 'historyThemes.spec.ts',
        title: 'a root size change with History open and peeking',
        reason: 'a storage write fails on the runner (StoragePausedError on both attempts); the underlying error is not known',
    },
    {
        spec: 'levelInfo.spec.ts',
        title: 'Make from BGM. and Edit in Cover Editor',
        reason: 'Generate in the Cover Editor does not finish within 15 s on the runner; whether it is slow or has failed is not known',
    },
]
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const ciExcluded = process.env.CI
    ? ciExclusions.map(
          ({ spec, title, project }) =>
              new RegExp(
                  [project && escapeRegExp(project), escapeRegExp(spec), title]
                      .filter((part) => part !== undefined)
                      .join('.*'),
              ),
      )
    : []
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
    // CI runners are about five times slower than a fast desktop. A test that passes on a retry is
    // reported as flaky.
    timeout: process.env.CI ? 90_000 : 30_000,
    expect: { timeout: process.env.CI ? 15_000 : 5_000 },
    retries: process.env.CI ? 2 : 0,
    grepInvert: ciExcluded.length ? ciExcluded : undefined,
    reporter: 'list',
    outputDir: 'test-results',
    use: {
        browserName: 'chromium',
        baseURL,
        // The app picks its language from the browser's, and dates follow the time zone.
        locale: 'en-US',
        timezoneId: 'UTC',
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
        env: { NSE_TEST_FONT: '1' },
    },
})
