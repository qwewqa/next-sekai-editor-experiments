import { defineConfig } from '@playwright/test'
import { AGREED, AGREEMENT_KEY } from './tests/helpers/agreement'

// The specs build dates in Node and read them from the page: both run in UTC, whatever the machine uses.
process.env.TZ = 'UTC'

// Build with `npm run build:release` first, or set PRODUCTION_TEST_URL to check
// the deployed site. Neither mode loads Vite development modules.
const hostedUrl = process.env.PRODUCTION_TEST_URL
// Parallel local runs can each choose a free preview server port.
const previewPort = process.env.PLAYWRIGHT_PREVIEW_PORT ?? '5211'
const previewUrl = `http://127.0.0.1:${previewPort}`
const baseURL = hostedUrl ?? previewUrl

export default defineConfig({
    testDir: './tests/production',
    testMatch: '**/*.spec.ts',
    workers: 1,
    forbidOnly: !!process.env.CI,
    // A test that passes on a retry is reported as flaky.
    retries: process.env.CI ? 2 : 0,
    timeout: 60_000,
    expect: { timeout: 10_000 },
    // On CI the JSON report feeds scripts/flaky-report.mjs, which lists the tests that passed only on a retry.
    reporter: process.env.CI ? [['list'], ['json', { outputFile: 'flaky/raw.json' }]] : 'list',
    outputDir: 'test-results-production',
    use: {
        browserName: 'chromium',
        baseURL,
        // The agreement counts as given; its own spec starts without the record.
        storageState: {
            cookies: [],
            origins: [
                {
                    origin: new URL(baseURL).origin,
                    localStorage: [{ name: AGREEMENT_KEY, value: AGREED }],
                },
            ],
        },
        locale: 'en-US',
        timezoneId: 'UTC',
        viewport: { width: 1600, height: 1000 },
        deviceScaleFactor: 1.25,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        launchOptions: {
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
            args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        },
    },
    webServer: hostedUrl
        ? undefined
        : {
              command: `npx vite preview --host 127.0.0.1 --port ${previewPort} --strictPort`,
              url: previewUrl,
              reuseExistingServer: false,
              timeout: 30_000,
          },
})
