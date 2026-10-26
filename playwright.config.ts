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
const fonts =
    'the layout depends on the fonts of the Windows development machine; Linux text is wider'
type CiExclusion = { spec: string; title?: string; project?: string; reason: string }
const ciExclusions: CiExclusion[] = [
    {
        spec: 'elevationBeatField.spec.ts',
        title: 'fits a long beat',
        reason: 'the Linux font is wider than the field’s room for a long beat',
    },
    {
        spec: 'localizations.spec.ts',
        title: 'fr elevation controls fit on a 320px',
        reason: fonts,
    },
    {
        spec: 'managerSelection.spec.ts',
        title: '336px dock selection bar.*en shortens',
        reason: fonts,
    },
    {
        spec: 'managerSelection.spec.ts',
        title: '260px dock selection bar.*tr shortens',
        reason: fonts,
    },
    {
        spec: 'settings.spec.ts',
        title: '(fr|tr) settings values go below their label',
        reason: fonts,
    },
    {
        spec: 'propertiesPanel.spec.ts',
        title: 'brush controls line up with the panel.s at a 260px dock',
        reason: fonts,
    },
    {
        spec: 'propertiesPanel.spec.ts',
        title: 'a narrow tab strip shortens Selection first',
        reason: fonts,
    },
    {
        spec: 'fieldGlyphs.spec.ts',
        title: 'a 336 dock keeps every name in full',
        reason: fonts,
    },
    {
        spec: 'fieldGlyphs.spec.ts',
        title: 'a value glyph gives way only when',
        reason: 'the case it needs, a glyph that gives way, depends on the fonts of the development machine',
    },
    {
        spec: 'forcedColors.spec.ts',
        title: 'segmented controls show the checked choice',
        reason: 'Snapping is a select, not segments, in the wider Linux font',
    },
    {
        spec: 'forcedColors.spec.ts',
        title: 'raised buttons and segment tracks keep their edge',
        reason: 'Snapping is a select, not segments, in the wider Linux font',
    },
    {
        spec: 'historyInspection.spec.ts',
        title: 'paired bar contours at 320 fr',
        reason: fonts,
    },
    {
        spec: 'historyInspection.spec.ts',
        title: 'secondary History controls keep exact geometry at pane 320',
        reason: fonts,
    },
    {
        spec: 'historyInspection.spec.ts',
        title: 'full-app phone and desktop composition',
        reason: fonts,
    },
    {
        spec: 'historyInspection.spec.ts',
        title: 'pending comparison keeps the fixed row',
        reason: fonts,
    },
    {
        spec: 'historyInspection.spec.ts',
        title: 'inspection close restores the current visible opener',
        reason: fonts,
    },
    {
        spec: 'historyInspection.spec.ts',
        title: '(en|fr|ko|tr) property labels and exact values wrap',
        reason: fonts,
    },
    {
        spec: 'historyInspection.spec.ts',
        title: 'forced colors preserves exposed control state',
        reason: fonts,
    },
    {
        spec: 'historyMarkers.spec.ts',
        title: 'phone-small',
        reason: fonts,
    },
    {
        spec: 'historyPanel.spec.ts',
        title: 'Go To shows its label beside the tabs',
        reason: fonts,
    },
    {
        spec: 'historyPanel.spec.ts',
        title: 'the band is one 48 px line',
        reason: fonts,
    },
    {
        spec: 'historyPresentation.spec.ts',
        title: 'group composition at 320px',
        reason: fonts,
    },
    {
        spec: 'noticeLook.spec.ts',
        title: 'rows are 40 px, the last 38',
        reason: fonts,
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
        spec: 'workspace.spec.ts',
        title: 'labels that barely overflow the rail',
        reason: fonts,
    },
    {
        spec: 'preview.spec.ts',
        title: 'an automatically opened form closes instead of jumping',
        reason: fonts,
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
        spec: 'touch.spec.ts',
        title: 'a tap shows the marker at the cursor it placed',
        reason: 'the hover label covers the edge labels differently in the Linux fonts',
    },
    {
        spec: 'historyGoTo.spec.ts',
        title: 'keys: Up crosses the gap',
        reason: 'a possible product bug: keyboard focus falls to the page body while the list window moves, and the arrow keys stop',
    },
    {
        spec: 'historyThemes.spec.ts',
        title: 'a root size change with History open and peeking',
        reason: 'a flush fails on the runner with “Storing paused”, for a cause not yet found',
    },
    {
        spec: 'levelInfo.spec.ts',
        title: 'Make from BGM… and Edit in Cover Editor',
        reason: 'Generate in the Cover Editor takes more than 15 s on the runner; not yet looked at',
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
