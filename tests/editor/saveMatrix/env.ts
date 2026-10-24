import { registerHooks } from 'node:module'

// What the Save core needs to load in Node: its
// modules import Vue components, Vite worker URLs, assets and `import.meta.env`, and read two
// singletons that only the browser's startup sets (the storage worker and the flusher). A hook
// pair swaps those for stubs under ./stubs and the browser-only catalogue loader for the English
// JSON; nothing under src/ changes. node:test runs each file in its own process, so these hooks
// stay in the one that registers them.

// The few browser globals the modules read at load or call.
const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
        getItem: (key: string) => memory.get(key) ?? null,
        setItem: (key: string, value: string) => void memory.set(key, String(value)),
        removeItem: (key: string) => void memory.delete(key),
        clear: () => memory.clear(),
        key: (index: number) => [...memory.keys()][index] ?? null,
        get length() {
            return memory.size
        },
    },
})
const target = new EventTarget()
const listen = target.addEventListener.bind(target)
const classes = new Set<string>()
/** What the navigator reports as transient activation: the harness turns it off to lapse a press. */
export const activation = { active: true }
Object.defineProperty(navigator, 'userActivation', {
    configurable: true,
    get: () => ({ isActive: activation.active }),
})
const documentStub = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
    hasFocus: () => true,
    documentElement: {
        toggleAttribute: () => false,
        classList: { add: () => undefined, remove: () => undefined, toggle: () => false },
        style: {},
        setAttribute: () => undefined,
        removeAttribute: () => undefined,
        dataset: {},
    },
    body: { classList: { add: () => undefined, remove: () => undefined } },
    addEventListener: listen,
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ style: {}, setAttribute: () => undefined, addEventListener: listen }),
    fullscreenElement: null,
})
const windowStub = Object.assign(target, {
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 1,
    location: { search: '', href: 'http://localhost/', hash: '' },
    requestAnimationFrame: (fn: () => void) => Number(setTimeout(fn, 16).unref()),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
})
void classes
// An open BroadcastChannel keeps the process alive (a takeover broadcasts): a channel to nobody.
class SilentChannel {
    onmessage = null
    postMessage() {}
    close() {}
    addEventListener() {}
    removeEventListener() {}
}

Object.assign(globalThis, {
    BroadcastChannel: SilentChannel,
    window: windowStub,
    requestAnimationFrame: windowStub.requestAnimationFrame,
    cancelAnimationFrame: windowStub.cancelAnimationFrame,
    document: documentStub,
    matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
    }),
})

const here = (path: string) => new URL(path, import.meta.url).href
const src = (path: string) => here(`../../../src/${path}`)

const redirect: Record<string, string> = {
    [src('local/start.ts')]: here('./stubs/start.ts'),
    [src('local/storing.ts')]: here('./stubs/storing.ts'),
    [src('editor/save/dialogs.ts')]: here('./stubs/dialogs.ts'),
    [src('editor/commands/exportLevel/ui.ts')]: here('./stubs/exportUi.ts'),
}

const sources: Record<string, string> = {
    [src('i18n/localizations.ts')]: [
        `import en from ${JSON.stringify(src('i18n/en/index.json'))} with { type: 'json' }`,
        'export const localizations = { en }',
    ].join('\n'),
}

const env =
    'import.meta.env ??= { DEV: false, PROD: true, MODE: "test", BASE_URL: "/", SSR: false };\n'

registerHooks({
    resolve: (specifier, context, next) => {
        if (specifier.includes('?worker'))
            return {
                url: 'data:text/javascript,export default ""',
                format: 'module',
                shortCircuit: true,
            }
        const resolved = next(specifier, context)
        const to = redirect[resolved.url]
        return to ? { ...resolved, url: to, shortCircuit: true } : resolved
    },
    load: (url, context, next) => {
        if (url.endsWith('.vue'))
            return { format: 'module', shortCircuit: true, source: 'export default {}' }
        if (/\.(mp3|ogg|wav|svg|png|jpg|webp|woff2?|css)(\?.*)?$/.test(url))
            return { format: 'module', shortCircuit: true, source: 'export default ""' }
        if (url in sources) return { format: 'module', shortCircuit: true, source: sources[url]! }
        const loaded = next(url, context)
        if (url.startsWith(src('')) && loaded.source !== undefined) {
            const text = String(loaded.source)
            if (text.includes('import.meta.env')) return { ...loaded, source: env + text }
        }
        return loaded
    },
})
