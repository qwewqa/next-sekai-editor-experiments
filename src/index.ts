import 'pixi.js/unsafe-eval'
import './csp'
// Before anything imports the settings: it snapshots the stored keys (Part 1 §1.7.3).
import './launch'

import './index.css'
import './selectLists.css'
import './themes.css'

import { createApp } from 'vue'
import App from './App.vue'
import { installSelectLists } from './modals/form/selectLists'
// After App: settings' import cycle must be entered from App's side.
import './theme'

installSelectLists()

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) throw new Error('Missing editor root element')
createApp(App).mount(root)

// The storage worker and the local-data modules load after first paint (Part 1 §1.6.5).
requestAnimationFrame(() => {
    setTimeout(() => {
        void import('./local/start').then(({ startStorage }) => startStorage())
    }, 0)
})
