import { defineConfig } from '@playwright/test'

// The v1 format fixtures' writer (npm run fixtures:v1; Part 1 §1.6.11.9): it drives the real editor
// on a dev server and writes the fixtures only with NSE_WRITE_FIXTURES=1. Run it once, before the
// v0.6.0 tag, with TZ=UTC.
const port = process.env.PLAYWRIGHT_PORT ?? '5283'

export default defineConfig({
    testDir: './tests/fixtures-v1',
    testMatch: '**/*.fixtures.ts',
    workers: 1,
    timeout: 60 * 60_000,
    reporter: 'list',
    outputDir: 'test-results/fixtures',
    use: {
        browserName: 'chromium',
        baseURL: `http://127.0.0.1:${port}`,
        viewport: { width: 1600, height: 1000 },
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        actionTimeout: 10_000,
        launchOptions: {
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
            args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        },
    },
    webServer: {
        command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
        url: `http://127.0.0.1:${port}`,
        reuseExistingServer: true,
        timeout: 60_000,
    },
})
