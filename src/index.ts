import 'pixi.js/unsafe-eval'
import './csp'
// Stops the bundle before the app's modules where the support gate has shown its page.
import './support'
// Before anything imports the settings: it snapshots the stored keys (Part 1 §1.7.3).
import './launch'

import './index.css'
import './selectLists.css'
import './themes.css'

import { createApp } from 'vue'
import App from './App.vue'
import { i18n } from './i18n'
import { installSelectLists } from './modals/form/selectLists'
import { appVersion, platform } from './platform'
import { setRawExport, trackStartup } from './startup/gate'
import { startsBlankForTests } from './startup/testHook'
// After App: settings' import cycle must be entered from App's side.
import './theme'

// Dev builds only: `?seedSample=<name>` seeds a sample before anything opens the database, then
// reloads (src/local/seed.ts).
if (import.meta.env.DEV && new URLSearchParams(location.search).has('seedSample')) {
    const { seedSampleFromUrl } = await import('./local/seed')
    if (await seedSampleFromUrl()) await new Promise<never>(() => undefined)
}

installSelectLists()

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) throw new Error('Missing editor root element')
createApp(App).mount(root)

// The storage worker and the local-data modules load after first paint (Part 1 §1.6.5), with
// a timer, not a frame: an unfocused tab schedules no frames.
const starting = new Promise<void>((resolve, reject) => {
    setTimeout(() => {
        import('./local/start').then(({ startStorage }) => startStorage()).then(resolve, reject)
    }, 0)
})

// The startup gate (Part 1 §1.4.2) covers what the session's opening takes: the database, the
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

// Export Raw Data… on the gate's error state (Part 1 §1.4.14): it reads the stored data on the page,
// without the code that failed. The module loads when it is used.
setRawExport({
    label: () => i18n.value.settings.localData.exportRaw,
    run: async () => {
        try {
            const { exportRawData, rawExportName } = await import('./local/rawExport')
            await exportRawData(
                appVersion().appVersion,
                rawExportName(i18n.value.settings.localData.exportRawName),
                (name, blob) =>
                    platform.saveFile({
                        kind: 'recovery',
                        suggestedName: name,
                        build: () => Promise.resolve(blob),
                    }),
            )
        } catch (error) {
            console.error(error)
        }
    },
})
