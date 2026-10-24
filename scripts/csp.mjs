import { createHash } from 'node:crypto'

// One base policy, with the native and dev additions. The web adds nothing: it
// makes no cross-origin requests.
const base = {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'wasm-unsafe-eval'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'blob:', 'data:'],
    'media-src': ["'self'", 'blob:'],
    'font-src': ["'self'", 'data:'],
    'worker-src': ["'self'", 'blob:'],
    'connect-src': ["'self'", 'blob:', 'data:'],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'frame-src': ["'none'"],
}

export const nativeAdditions = { 'connect-src': ['ipc:', 'http://ipc.localhost'] }
export const devAdditions = { 'connect-src': ['ws://127.0.0.1:*'] }

/** The sources `script-src` takes for these inline scripts' texts. */
export const scriptHashes = (scripts) =>
    [...new Set(scripts)].map(
        (text) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`,
    )

function policy(additions, scripts) {
    const directives = { ...base }
    for (const [name, sources] of Object.entries(additions))
        directives[name] = [...directives[name], ...sources]
    directives['script-src'] = [...directives['script-src'], ...scriptHashes(scripts)]
    return Object.entries(directives)
        .map(([name, sources]) => `${name} ${sources.join(' ')}`)
        .join('; ')
}

/** Each takes the texts of the page's inline scripts, which get a hash source. */
export const basePolicy = (scripts = []) => policy({}, scripts)
export const webPolicy = (scripts = []) => policy({}, scripts)
export const nativePolicy = (scripts = []) => policy(nativeAdditions, scripts)
export const devPolicy = (scripts = []) => policy(devAdditions, scripts)

/** The text of every inline script: a `<script>` without `src`, as the browser hashes it. */
export function inlineScripts(html) {
    return [...html.matchAll(/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi)]
        .filter(([, attributes]) => !/(?:^|\s)src\s*=/i.test(attributes))
        .map(([, , text]) => text)
}

const metaPattern = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/i

/** The page's meta policy, or undefined. */
export const pageMetaPolicy = (html) => metaPattern.exec(html)?.[1]

/** Whether the meta tag is `<head>`'s first child. */
export const metaIsFirst = (html) =>
    /<head(?:\s[^>]*)?>\s*<meta\s+http-equiv="Content-Security-Policy"/i.test(html)

/** The page with the policy as a meta tag, `<head>`'s first child, hashing its inline scripts. */
export function injectPolicy(html, makePolicy) {
    if (pageMetaPolicy(html) !== undefined) throw new Error('The page already has a CSP meta tag')
    const content = makePolicy(inlineScripts(html))
    if (/["&<>]/.test(content)) throw new Error('The policy cannot go in an attribute')
    const head = /<head(?:\s[^>]*)?>/i.exec(html)
    if (!head) throw new Error('The page has no <head>')
    const end = head.index + head[0].length
    return `${html.slice(0, end)}\n        <meta http-equiv="Content-Security-Policy" content="${content}" />${html.slice(end)}`
}
