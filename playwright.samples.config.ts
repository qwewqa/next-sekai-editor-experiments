import { defineConfig } from '@playwright/test'

// The sample generators (npm run samples:long-history), kept out of test:browser: each drives the
// real editor on a dev server and writes a dump into the nse-next samples/ folder.
const port = process.env.PLAYWRIGHT_PORT ?? '5283'

export default defineConfig({
    testDir: './tests/samples',
    testMatch: '**/*.samples.ts',
    workers: 1,
    timeout: 30 * 60_000,
    reporter: 'list',
    outputDir: 'test-results/samples',
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
