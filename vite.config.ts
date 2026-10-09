import vue from '@vitejs/plugin-vue'
import autoprefixer from 'autoprefixer'
import tailwind from 'tailwindcss'
import { defineConfig } from 'vite'
import { name, version } from './package.json'
import { themes } from './src/themes'

// https://vitejs.dev/config/
export default defineConfig({
    server: {
        watch: { ignored: ['**/test-results*/**', '**/playwright-report/**'] },
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
                    .replace('getItem(THEME_KEY)', `getItem(${JSON.stringify(`${name}.theme`)})`)
            },
        },
    ],
    define: {
        __APP_VERSION__: JSON.stringify(
            (process.env.GITHUB_SHA && `${version}+${process.env.GITHUB_SHA.slice(0, 8)}`) ||
                (process.env.CF_PAGES_BRANCH !== 'prod' &&
                    process.env.CF_PAGES_COMMIT_SHA?.slice(0, 8)) ||
                version,
        ),
    },
})
