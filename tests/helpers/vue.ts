// The app's own Vue, for code evaluated in the page: Vite rewrites this import to the URL the app
// loaded, so it is the same instance even under a fake clock, which hides resource timing entries.
export { nextTick } from 'vue'
