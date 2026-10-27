import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
    basePolicy,
    devPolicy,
    injectPolicy,
    inlineScripts,
    metaIsFirst,
    nativePolicy,
    pageMetaPolicy,
    scriptHashes,
    webPolicy,
} from '../../scripts/csp.mjs'

const directives = (policy) =>
    Object.fromEntries(
        policy.split('; ').map((directive) => {
            const [name, ...sources] = directive.split(' ')
            return [name, sources]
        }),
    )

// What the second policy adds to the first, directive by directive; it removes nothing.
const added = (policy, over) => {
    const a = directives(policy)
    const b = directives(over)
    assert.deepEqual(Object.keys(a), Object.keys(b))
    const result = {}
    for (const name of Object.keys(a)) {
        assert.ok(
            a[name].every((source) => b[name].includes(source)),
            `${name} loses nothing`,
        )
        const extra = b[name].filter((source) => !a[name].includes(source))
        if (extra.length) result[name] = extra
    }
    return result
}

test('the base policy is the expected one', () => {
    assert.equal(
        basePolicy(),
        [
            "default-src 'self'",
            "script-src 'self' 'wasm-unsafe-eval'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' blob: data:",
            "media-src 'self' blob:",
            "font-src 'self' data:",
            "worker-src 'self' blob:",
            "connect-src 'self' blob: data:",
            "object-src 'none'",
            "base-uri 'none'",
            "frame-src 'none'",
        ].join('; '),
    )
})

test('the web policy is the base, and the native one differs only by its additions', () => {
    // Without a usage statistics target, the web makes no cross-origin requests.
    assert.equal(webPolicy(), basePolicy())
    assert.doesNotMatch(webPolicy(), /https:/)
    assert.deepEqual(added(basePolicy(), nativePolicy()), {
        'connect-src': ['ipc:', 'http://ipc.localhost'],
    })
    assert.deepEqual(added(webPolicy(), devPolicy()), { 'connect-src': ['ws://127.0.0.1:*'] })
})

test('a usage statistics target adds its origin to connect-src, and nothing else', () => {
    const origin = 'https://stats.nse-services.qwewqa.dev'
    assert.deepEqual(added(webPolicy(), webPolicy([], origin)), { 'connect-src': [origin] })
    assert.deepEqual(added(devPolicy(), devPolicy([], origin)), { 'connect-src': [origin] })
    assert.deepEqual(
        webPolicy([], origin).match(/https:[^ ;]*/g),
        [origin],
        'the only https: source is the target',
    )
})

test('no policy allows eval or leaves the native build reaching the network', () => {
    for (const policy of [webPolicy(), nativePolicy(), devPolicy()]) {
        assert.deepEqual(directives(policy)['script-src'], ["'self'", "'wasm-unsafe-eval'"])
        assert.doesNotMatch(policy.replaceAll("'wasm-unsafe-eval'", ''), /unsafe-eval/)
    }
    assert.doesNotMatch(nativePolicy(), /https:/)
})

test('hashes of inline scripts go into script-src only', () => {
    const text = '\n  document.title = "x"\n'
    const hash = `'sha256-${createHash('sha256').update(text).digest('base64')}'`
    assert.deepEqual(scriptHashes([text, text]), [hash])
    for (const make of [webPolicy, nativePolicy, devPolicy]) {
        const policy = make([text])
        assert.deepEqual(directives(policy)['script-src'], ["'self'", "'wasm-unsafe-eval'", hash])
        assert.equal(policy.split(hash).length, 2)
    }
})

test('inline scripts are those without src', () => {
    const html = `<head><script>a()</script><script type="module" src="/x.js"></script>
<script type='module'>b("</")</script><SCRIPT data-x=">" >c()</SCRIPT><script src = "/y.js"></script></head>`
    assert.deepEqual(inlineScripts(html), ['a()', 'b("</")', 'c()'])
})

test('the meta tag is the first child of head, with or without attributes', () => {
    for (const head of ['<head>', '<head lang="en">', '<HEAD\n data-a="b">']) {
        const html = `<!doctype html><html>${head}<meta charset="UTF-8" /><script>a()</script></head></html>`
        const out = injectPolicy(html, webPolicy)
        assert.ok(metaIsFirst(out), head)
        assert.equal(pageMetaPolicy(out), webPolicy(['a()']))
        assert.equal(out.replace(/\n\s*<meta http-equiv[^>]*>/, ''), html)
    }
    assert.throws(() => injectPolicy('<html></html>', webPolicy), /no <head>/)
    assert.throws(
        () => injectPolicy(injectPolicy('<head></head>', webPolicy), webPolicy),
        /already/,
    )
    assert.equal(metaIsFirst('<head><meta charset="UTF-8" /></head>'), false)
})

test('every inline script of every entry gets a hash, and nothing else does', () => {
    const entries = ['index.html', 'privacy/index.html', 'terms/index.html']
    for (const file of entries) {
        const html = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
        const scripts = inlineScripts(html)
        assert.ok(scripts.length > 0, file)
        const sources = directives(pageMetaPolicy(injectPolicy(html, webPolicy)))['script-src']
        for (const hash of scriptHashes(scripts)) assert.ok(sources.includes(hash), file)
        assert.equal(sources.length, 2 + new Set(scripts).size, file)
    }
})
