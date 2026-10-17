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
import { installSelectLists } from './modals/form/selectLists'
import { trackStartup } from './startup/gate'
// After App: settings' import cycle must be entered from App's side.
import './theme'

installSelectLists()

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) throw new Error('Missing editor root element')
createApp(App).mount(root)

// The storage worker and the local-data modules load after first paint (Part 1 §1.6.5), with
// a timer, not a frame: an unfocused tab schedules no frames.
// The startup gate lifts when it is done, or shows the error if it throws (Part 1 §1.4.2).
setTimeout(() => {
    trackStartup(import('./local/start').then(({ startStorage }) => startStorage()))
}, 0)
