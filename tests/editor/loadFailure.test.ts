import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

// The i18n modules need a browser (see fileLabel.test.ts); the notice module is replaced by one
// that keeps each message it is given.
const here = (path: string) => new URL(path, import.meta.url).href
const stubs: Record<string, string> = {
    [here('../../src/i18n/localizations.ts')]: [
        `import en from ${JSON.stringify(here('../../src/i18n/en/index.json'))} with { type: 'json' }`,
        'export const localizations = { en }',
    ].join('\n'),
    [here('../../src/settings.ts')]: [
        "import { reactive } from 'vue'",
        "export const settings = reactive({ locale: 'en' })",
    ].join('\n'),
    [here('../../src/diagnostics.ts')]: 'export const recordError = () => {}',
    [here('../../src/editor/notification.ts')]: [
        'export const notified = []',
        'export const notify = (message, options) => notified.push({ text: message(), ...options })',
    ].join('\n'),
}
registerHooks({
    load: (url, context, next) =>
        url in stubs
            ? { format: 'module', shortCircuit: true, source: stubs[url] }
            : next(url, context),
})

const { loadForAction } = await import('../../src/editor/loadFailure')
const { notified } = (await import('../../src/editor/notification')) as unknown as {
    notified: { text: string; card?: boolean; severity?: string }[]
}
const { describeFailure } = await import('../../src/modals/loadingFailure')
const { importForTask } = await import('../../src/utils/error')

const reload = 'This could not be loaded. Reload the page to try again.'
const missing = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module'))

test('code that does not load for an action shows the reload card', async () => {
    assert.equal(await loadForAction(missing), undefined)
    assert.deepEqual(notified, [{ text: reload, card: true, severity: 'error' }])
})

test('a loading task names code that did not load, and other failures as before', async () => {
    const failure = await importForTask(missing).catch((error: unknown) => error)
    assert.equal(describeFailure(failure).headline?.(), reload)
    assert.equal(
        describeFailure(new DOMException('Quota exceeded', 'QuotaExceededError')).headline?.(),
        'This could not be completed.',
    )
})
