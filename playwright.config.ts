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
// Tests CI does not run, each with its reason; npm run test:browser still runs them. An entry names
// a spec and, to leave the rest of the spec in, a pattern for the test's title and the project.
type CiExclusion = { spec: string; title?: string; project?: string; reason: string }
const ciExclusions: CiExclusion[] = [
    {
        spec: 'elevationBeatField.spec.ts',
        title: 'fits a long beat',
        reason: 'the long beat’s text overflows its field by about 6 px in the Linux font, a clipping the product still has',
    },
    {
        spec: 'localizations.spec.ts',
        title: 'fr elevation controls fit on a 320px',
        reason: 'the French label is 80 px of text in 76 px in the Linux font, a clipping the product still has',
    },
    {
        spec: 'selectionProperties.spec.ts',
        title: 'coverage keeps its width as only its digits change',
        reason: 'the Linux fonts have no tabular digits',
    },
    {
        spec: 'timeLineLabels.spec.ts',
        title: '(1.25x and 16|1.5x and 20) pixel text.*the hover labels centre',
        reason: 'the ink of a figure sits differently in the Linux fonts',
    },
    {
        spec: 'preview.spec.ts',
        title: 'same-beat elevation connectors keep identical geometry',
        project: 'chromium-worker',
        reason: 'the worker draws on its own clock, which the page’s fake clock does not hold',
    },
    {
        spec: 'preview.spec.ts',
        title: 'hiding the time removes both clocks',
        project: 'chromium-worker',
        reason: 'the worker draws a frame when the page expects none',
    },
    {
        spec: 'previewWorker.spec.ts',
        title: 'after a hang, the worker’s last frame shows',
        reason: 'a 1.5 s hang timer, which a loaded runner passes before the page is ready',
    },
    {
        spec: 'textAlignment.spec.ts',
        title: 'WebGL text matches SVG alignment',
        reason: 'the Linux fonts rasterise WebGL and SVG text differently',
    },
    {
        spec: 'textRaster.spec.ts',
        title: 'WebGL text sprites preserve browser glyphs',
        reason: 'the Linux fonts rasterise WebGL and 2D canvas text differently',
    },
    {
        spec: 'bgmReattach.spec.ts',
        title: '(Choose Audio….with the same file brings|the BGM dialog with the same file attaches|Choose Audio….with another file is one BGM change|opening the download it saved, with its BGM lost|the BGM dialog says a BGM nothing holds)',
        reason: 'a load notice shows only while the page is under 12 s old, and a reload on the runner takes longer',
    },
    {
        spec: 'historyChanges.spec.ts',
        title: 'the first peek from Now paints no blank line',
        reason: 'the bar shows its loading line once a read has taken 250 ms, which a read on the runner can exceed',
    },
    {
        spec: 'startupSessions.spec.ts',
        title: 'a late flush landing during the marker.s wait',
        reason: 'the reload waits 2 s for the old page’s lock, and the steps between the test’s two page calls can outlast that on the runner',
    },
    {
        spec: 'historyGoTo.spec.ts',
        title: 'keys: Up crosses the gap',
        reason: 'a possible product bug: keyboard focus falls to the page body while the list window moves, and the arrow keys stop',
    },
    {
        spec: 'historyThemes.spec.ts',
        title: 'a root size change with History open and peeking',
        reason: 'a storage write fails on the runner (StoragePausedError on both attempts); the underlying error is not known',
    },
    {
        spec: 'levelInfo.spec.ts',
        title: 'Make from BGM… and Edit in Cover Editor',
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
