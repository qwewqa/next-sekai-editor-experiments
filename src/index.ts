import 'pixi.js/unsafe-eval'
import './csp'

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
