declare const __NSE_PERF__: boolean

import 'pixi.js/unsafe-eval'
import './csp'
// Stops the bundle before the app's modules where the support gate has shown its page.
import './support'
// Before anything imports the settings: it snapshots the stored keys.
import './launch'

import './index.css'
import './selectLists.css'
import './themes.css'

import { createApp } from 'vue'
import App from './App.vue'
import { startAnalytics } from './analytics/start'
import { installSelectLists } from './modals/form/selectLists'
import { trackStartup } from './startup/gate'
import { registerGateRawExport } from './startup/rawExportAction'
import { startsBlankForTests } from './startup/testHook'
// After App: settings' import cycle must be entered from App's side.
import './theme'

// Dev and perf builds only: `?seedSample=<name>` seeds a sample before anything opens the
// database, then reloads (src/local/seed.ts).
const seeds = import.meta.env.DEV || (typeof __NSE_PERF__ === 'boolean' && __NSE_PERF__)
if (seeds && new URLSearchParams(location.search).has('seedSample')) {
    const { seedSampleFromUrl } = await import('./local/seed')
    if (await seedSampleFromUrl()) await new Promise<never>(() => undefined)
}

// Perf builds only (`NSE_PERF=1`): the harness's handle (docs/performance-testing.md).
if (typeof __NSE_PERF__ === 'boolean' && __NSE_PERF__) void import('./perf/hook')

installSelectLists()

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) throw new Error('Missing editor root element')
createApp(App).mount(root)

// The storage worker and the local-data modules load after first paint, with
// a timer, not a frame: an unfocused tab schedules no frames.
const starting = new Promise<void>((resolve, reject) => {
    setTimeout(() => {
        import('./local/start').then(({ startStorage }) => startStorage()).then(resolve, reject)
    }, 0)
})

// The startup gate covers what the session's opening takes: the database, the
// recovery order and loading the session. Under the fixture hook every load starts blank, at once.
// Read here, not from the storage modules, which load after first paint.
const startsBlank = startsBlankForTests()
if (startsBlank) {
    trackStartup(Promise.resolve())
    // The specs' fixture fails on it, so a broken startup never passes unseen.
    starting.catch((error: unknown) => {
        console.error(error)
        window.nseStartupError = String(error)
    })
} else trackStartup(starting)

// Export Raw Data on the gate's error state: it reads the stored data on the page,
// without the code that failed. The module loads when it is used.
registerGateRawExport()

// Usage statistics, when the build has a target and they are on: the client loads once startup
// is done and the page is idle (docs/analytics.md).
startAnalytics()
