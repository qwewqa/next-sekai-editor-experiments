import vue from '@vitejs/plugin-vue'
import autoprefixer from 'autoprefixer'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwind from 'tailwindcss'
import { defaultClientConditions, defineConfig } from 'vite'
import { devPolicy, injectPolicy, nativePolicy, webPolicy } from './scripts/csp.mjs'
import { nativeIndexHtml } from './scripts/native.mjs'
import { probePlugin, samplesPlugin } from './scripts/samples.mjs'
import { applyTestSite, siteFromEnv } from './scripts/site.mjs'
import { appVersion } from './scripts/version.mjs'
import { PRODUCT_NAME } from './src/product'
import { storageKey } from './src/storage'
import { themes } from './src/themes'

const repository = process.env.GITHUB_REPOSITORY || 'qwewqa/next-sekai-editor-experiments'
const root = fileURLToPath(new URL('.', import.meta.url))

// The Vite entries; the editor's is 'index' to keep its index-* chunk names. The apps' build has the editor only.
const pages = (mode: string) => ({
    index: resolve(root, 'index.html'),
    ...(mode !== 'native' && existsSync(resolve(root, 'privacy/index.html'))
        ? { privacy: resolve(root, 'privacy/index.html') }
        : {}),
})

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
    // Each checkout keeps its own dependency cache, so worktrees whose node_modules is a link to
    // another checkout's never rewrite that checkout's cache.
    cacheDir: '.vite-cache',
    server: {
        watch: { ignored: ['**/test-results*/**', '**/playwright-report/**'] },
    },
    resolve: {
        // Native mode: #platform and #asset-defaults take their native targets.
        conditions: mode === 'native' ? ['native', ...defaultClientConditions] : undefined,
    },
    build: {
        target: ['chrome106', 'edge106', 'firefox105', 'safari16', 'ios16'],
        rolldownOptions: { input: pages(mode) },
    },
    // The storage worker is written as a module worker and emitted as a classic one: Firefox 105
    // has no module workers, and an iife build can't split.
    worker: {
        format: 'iife',
    },
    css: {
        postcss: {
            plugins: [tailwind(), autoprefixer()],
        },
    },
    plugins: [
        vue(),
        // Dev only: the nse-next samples for `?seedSample=` (scripts/samples.mjs).
        samplesPlugin(root),
        // Dev only: the stored-handle probe page at /probe/handles.html.
        probePlugin(root),
        {
            // The pre-paint theme script in index.html reads the same themes and key as the app.
            name: 'theme-script',
            transformIndexHtml: (html) => {
                if (!html.includes('THEMES.includes') || !html.includes('getItem(THEME_KEY)'))
                    throw new Error('index.html: theme script placeholders not found')
                return html
                    .replace('THEMES.includes', `${JSON.stringify(themes)}.includes`)
                    .replace(
                        'getItem(THEME_KEY)',
                        `getItem(${JSON.stringify(storageKey('theme'))})`,
                    )
            },
        },
        {
            // The page title and share metadata take the product name from the one constant, and the
            // landing pages' links take the repository.
            name: 'product-name',
            transformIndexHtml: {
                // Before Vite's own %NAME% substitution, which would warn about this one.
                order: 'pre',
                handler: (html) =>
                    html
                        .replaceAll('%PRODUCT_NAME%', PRODUCT_NAME)
                        .replaceAll('%GITHUB_REPOSITORY%', repository),
            },
        },
        {
            // The apps' page has no web-only tags or icon.
            name: 'native-html',
            apply: () => mode === 'native',
            transformIndexHtml: nativeIndexHtml,
        },
        {
            // NSE_SITE=test: the test site is not indexed and its title says so.
            name: 'test-site',
            apply: () => siteFromEnv() === 'test',
            transformIndexHtml: applyTestSite,
        },
        {
            // The policy as the first child of <head>, hashing the inline scripts as they
            // end up, so it runs after theme-script. `vite dev` has none unless NSE_DEV_CSP=1.
            name: 'csp',
            apply: (_config, { command }) => command === 'build' || process.env.NSE_DEV_CSP === '1',
            transformIndexHtml: {
                order: 'post',
                handler: (html, { server }) =>
                    injectPolicy(
                        html,
                        server ? devPolicy : mode === 'native' ? nativePolicy : webPolicy,
                    ),
            },
        },
    ],
    define: {
        __GITHUB_REPOSITORY__: JSON.stringify(repository),
        __NSE_SITE__: JSON.stringify(siteFromEnv()),
        // NSE_PERF=1: a perf build with the frame probes (docs/performance-testing.md).
        __NSE_PERF__: JSON.stringify(process.env.NSE_PERF === '1'),
        __HAS_PRIVACY_PAGE__: JSON.stringify('privacy' in pages(mode)),
        __NATIVE__: JSON.stringify(mode === 'native'),
        __APP_VERSION__: JSON.stringify(appVersion({ cwd: root }).appVersion),
    },
}))
