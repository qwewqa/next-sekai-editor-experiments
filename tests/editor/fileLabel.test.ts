import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import type { LabelFile, LabelInput } from '../../src/editor/fileLabel'
import { initialStep } from '../helpers/historySteps'
import { goldenChart, stateOf } from '../local/records/charts'

// Two modules need a browser: src/i18n/localizations.ts collects the catalogues with Vite's
// import.meta.glob, and src/settings.ts reads media queries and storage. A load hook swaps them for
// the English catalogue and a settings object with only the locale.
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
}
registerHooks({
    load: (url, context, next) =>
        url in stubs
            ? { format: 'module', shortCircuit: true, source: stubs[url] }
            : next(url, context),
})

const { bindFile, fileChanged, writesInPlace } = await import('../../src/editor/file/state')
const { labelAccessibleName, labelLine, labelOf } = await import('../../src/editor/fileLabel')
const { displayedName, statusLabel, statusName, statusText } =
    await import('../../src/editor/labelText')
const { createSessionDescriptor, session } = await import('../../src/history/session')
const { resetStates } = await import('../../src/history/stack')

// The file part of a label comes from one function, `labelOf`: the status bar and a Recent
// Sessions row call it, so a row can never say what the status bar would not.

const at = new Date(2026, 9, 14, 15, 15).getTime()
const input = (rest: Partial<LabelInput> = {}): LabelInput => ({
    name: 'Coconut (Master)',
    changed: false,
    writesInPlace: true,
    ...rest,
})

test('a session that is not bound says so, a separate copy says what it is a copy of', () => {
    assert.deepEqual(labelOf(input()), {
        name: 'Coconut (Master)',
        state: 'not saved to a file',
        changed: false,
    })
    assert.equal(
        labelOf(input({ copyOf: { name: 'melt.nxsp' } })).state,
        'separate copy of melt.nxsp',
    )
    // An untitled source is the copy's own date name already.
    assert.equal(labelOf(input({ copyOf: { name: '' } })).state, 'separate copy')
})

test('a bound file is shown by name, with a • when it has changes', () => {
    const file: LabelFile = { name: 'coconut.nxsp', event: 'saved', at }
    const label = labelOf(input({ file, changed: true }))
    assert.deepEqual(label, { name: 'Coconut (Master)', file: 'coconut.nxsp', changed: true })
    assert.equal(labelLine(label), 'Coconut (Master) · coconut.nxsp •')
    // The bare file name when it is the name's stem.
    assert.equal(labelOf(input({ name: 'coconut', file })).name, '')
})

test('a download browser adds the event, an unknown event reads as a download', () => {
    const when = (event?: string) =>
        labelOf(
            input({
                writesInPlace: false,
                file: { name: 'a.nxsp', ...(event ? { event } : {}), at },
            }),
        ).state
    assert.match(when('downloaded') ?? '', /^downloaded /)
    assert.match(when('opened') ?? '', /^opened /)
    assert.match(when('future') ?? '', /^downloaded /)
    assert.equal(when('saved'), when('downloaded'))
    // Without a time there is nothing to say.
    assert.equal(
        labelOf(input({ writesInPlace: false, file: { name: 'a.nxsp', event: 'opened' } })).state,
        undefined,
    )
})

test('a row says a download is not confirmed, after the event and before what a check found', () => {
    const file: LabelFile = { name: 'a.nxsp', event: 'downloaded', at }
    const state = (rest: Partial<LabelInput>) =>
        labelOf(input({ writesInPlace: false, file, ...rest })).state ?? ''
    assert.match(state({ notConfirmed: true }), /^downloaded .* · download not confirmed$/)
    assert.match(
        state({ notConfirmed: true, diskFinding: 'changed' }),
        /download not confirmed · changed on disk$/,
    )
    // The status bar does not pass it: its chip says so.
    assert.doesNotMatch(state({}), /not confirmed/)
})

test('what a check found on disk joins the state', () => {
    const file: LabelFile = { name: 'a.nxsp', event: 'saved', at }
    assert.equal(labelOf(input({ file, diskFinding: 'missing' })).state, 'file missing')
    assert.notEqual(labelOf(input({ file, diskFinding: 'changed' })).state, undefined)
    assert.notEqual(labelOf(input({ file, diskFinding: 'newer' })).state, undefined)
    assert.equal(labelOf(input({ file })).state, undefined)
})

test('the accessible name says what changed since which event', () => {
    const name = (event: string, changed = true) => {
        const file: LabelFile = { name: 'coconut.nxsp', event, at }
        return labelAccessibleName(labelOf(input({ file, changed })), 'Coconut (Master)', file)
    }
    assert.match(name('saved'), /Coconut \(Master\).*coconut\.nxsp/)
    assert.notEqual(name('saved'), name('opened'))
    assert.notEqual(name('saved'), name('downloaded'))
    assert.equal(name('future'), name('downloaded'))
    // Unchanged: the label itself.
    assert.equal(name('saved', false), 'Coconut (Master) · coconut.nxsp')
})

test('a row built from a chain’s record says what the status bar says for the same session', () => {
    for (const event of ['saved', 'opened', 'downloaded', 'future']) {
        const state = stateOf(goldenChart())
        resetStates({ state, step: initialStep(), isDirty: false })
        session.value = createSessionDescriptor({ sessionId: 'x' })
        // A file event binds the session; the chain's record holds the same event and time.
        bindFile({ name: 'coconut.nxsp', event, at } as never, state)
        const stored: LabelFile = { name: 'coconut.nxsp', event, at }
        const row = labelOf({
            name: displayedName.value,
            file: stored,
            changed: fileChanged.value,
            writesInPlace: writesInPlace(),
        })
        assert.deepEqual(statusLabel.value, row, event)
        assert.equal(statusText.value, labelLine(row), event)
        assert.equal(statusName.value, labelAccessibleName(row, displayedName.value, stored), event)
    }
})
