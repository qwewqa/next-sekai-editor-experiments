import './index.css'
import './selectLists.css'
import './themes.css'

import { createApp } from 'vue'
import App from './App.vue'
import { installSelectLists } from './modals/form/selectLists'
// After App: settings' import cycle must be entered from App's side.
import './theme'

installSelectLists()

const app = createApp(App)

app.mount('#app')
