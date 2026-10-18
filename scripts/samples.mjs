import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// The dev server's `/samples/<name>.json`, for `?seedSample=<name>` (src/local/seed.ts): served
// from the nse-next `samples/` folder, never from `public/`, so no build ever holds a sample.

/** The nearest `samples/` folder above the checkout, or NSE_SAMPLES_DIR. */
export function samplesDir(root, env = process.env) {
    if (env.NSE_SAMPLES_DIR) return resolve(env.NSE_SAMPLES_DIR)
    for (let dir = dirname(root); dir !== dirname(dir); dir = dirname(dir)) {
        const candidate = join(dir, 'samples')
        if (
            candidate !== resolve(root) &&
            existsSync(candidate) &&
            statSync(candidate).isDirectory()
        )
            return candidate
    }
    return undefined
}

/** A Vite plugin, serve only. */
export function samplesPlugin(root) {
    return {
        name: 'dev-samples',
        apply: 'serve',
        configureServer(server) {
            server.middlewares.use('/samples/', (req, res, next) => {
                const name = decodeURIComponent((req.url ?? '').split('?')[0].replace(/^\//, ''))
                const dir = samplesDir(root)
                if (!dir || !/^[\w.-]+\.json$/.test(name) || !existsSync(join(dir, name))) {
                    next()
                    return
                }
                res.setHeader('Content-Type', 'application/json')
                res.setHeader('Cache-Control', 'no-store')
                res.end(readFileSync(join(dir, name)))
            })
        },
    }
}
