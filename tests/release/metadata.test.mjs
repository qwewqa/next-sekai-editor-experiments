import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { testTitlePrefix } from '../../scripts/site.mjs'
import product from '../../src/product.json' with { type: 'json' }

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** index.html as the project's own Vite plugins render it for a site. */
const render = async (site) => {
    const before = process.env.NSE_SITE
    if (site) process.env.NSE_SITE = site
    else delete process.env.NSE_SITE
    const server = await createServer({
        root,
        logLevel: 'silent',
        appType: 'custom',
        server: { middlewareMode: true },
    })
    try {
        return await server.transformIndexHtml(
            '/',
            await readFile(resolve(root, 'index.html'), 'utf8'),
        )
    } finally {
        await server.close()
        if (before === undefined) delete process.env.NSE_SITE
        else process.env.NSE_SITE = before
    }
}

const meta = (html, property) =>
    html.match(new RegExp(`<meta property="${property}" content="([^"]*)"`))?.[1]

for (const site of ['', 'test']) {
    test(`the page title and og tags come from the product name (${site || 'production'} site)`, async () => {
        const html = await render(site)
        const prefix = site === 'test' ? testTitlePrefix : ''
        assert.ok(!html.includes('%PRODUCT_NAME%'))
        assert.equal(html.match(/<title>([^<]*)<\/title>/)?.[1], `${prefix}${product.name}`)
        assert.equal(meta(html, 'og:title'), product.name)
        assert.equal(meta(html, 'og:site_name'), product.name)
    })
}
