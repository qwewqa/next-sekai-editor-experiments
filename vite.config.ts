import vue from '@vitejs/plugin-vue'
import autoprefixer from 'autoprefixer'
import { fileURLToPath } from 'node:url'
import tailwind from 'tailwindcss'
import { defaultClientConditions, defineConfig } from 'vite'
import { devPolicy, injectPolicy, nativePolicy, webPolicy } from './scripts/csp.mjs'
import { nativeIndexHtml } from './scripts/native.mjs'
import { applyTestSite, siteFromEnv } from './scripts/site.mjs'
import { appVersion } from './scripts/version.mjs'
import { storageKey } from './src/storage'
import { themes } from './src/themes'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
    server: {
        watch: { ignored: ['**/test-results*/**', '**/playwright-report/**'] },
    },
    resolve: {
        // Native mode (Part 2, 2.4.1): #platform and #asset-defaults take their native targets.
        conditions: mode === 'native' ? ['native', ...defaultClientConditions] : undefined,
    },
    build: {
        target: ['chrome106', 'edge106', 'firefox105', 'safari16', 'ios16'],
    },
    css: {
        postcss: {
            plugins: [tailwind(), autoprefixer()],
        },
    },
    plugins: [
        vue(),
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
            // The apps' page has no web-only tags or icon (Part 2, 2.7.1).
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
            // The policy (Part 0 §0.9.2) as the first child of <head>, hashing the inline scripts as they
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
        __NATIVE__: JSON.stringify(mode === 'native'),
        __APP_VERSION__: JSON.stringify(
            appVersion({ cwd: fileURLToPath(new URL('.', import.meta.url)) }).appVersion,
        ),
    },
}))
