import { defineConfig } from '@playwright/test'

// The stored file handle probe, kept out of test:browser: it runs in Edge and in Playwright's
// Chromium against the dev server's /probe/handles.html (npm run probe:handles).
const port = process.env.PLAYWRIGHT_PORT ?? '5287'

export default defineConfig({
    testDir: './tests/probe',
    testMatch: '**/*.probe.ts',
    workers: 1,
    timeout: 120_000,
    reporter: 'list',
    outputDir: 'test-results/probe',
    use: { baseURL: `http://127.0.0.1:${port}` },
    projects: [
        { name: 'edge', use: { channel: 'msedge' } },
        { name: 'chromium', use: { browserName: 'chromium' } },
    ],
    webServer: {
        command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
        url: `http://127.0.0.1:${port}/probe/handles.html`,
        reuseExistingServer: true,
        timeout: 60_000,
    },
})
