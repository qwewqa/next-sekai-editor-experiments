import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { HANDLES } from '../../src/local/handleRows'
import { listRecent } from '../../src/local/recent'
import { takeOver } from '../../src/local/save/bind'
import { createWorld } from '../../src/local/testing/world'
import { editStep, futureFixtureOperation } from '../helpers/historySteps'
import '../helpers/lockChecks'
import { openPage, workerCore } from './flush/harness'
import { goldenChart, stateOf } from './records/charts'
import { beginIn, handlersOf, readOpen } from './startup/harness'
import { widen } from './timeline/helpers'

// A Recent Sessions row of a closed chain whose file another chain took over: the list
// read and the label a row shows, `labelOf`, the status bar's.

// `labelOf` reads the catalogue and the locale: the English catalogue and a settings object with
// only the locale stand in for the browser modules (as in `tests/editor/fileLabel.test.ts`).
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

const { labelLine, labelOf } = await import('../../src/editor/fileLabel')

test('a row whose file another chain took over reads "Not saved to a file"', async () => {
    const world = createWorld({ seed: 1 })
    const page = await openPage(world, world.tab('a'))
    const state = stateOf(goldenChart())
    const session = beginIn(page, state)
    page.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) },
        widen(state, 1),
        true,
    )
    await page.flusher.flush()
    const { head } = await readOpen(page, session.id)
    const tab = world.tab('other')
    const core = workerCore(world, tab)
    await tab.run(() => core.start())
    const write = (change: Parameters<typeof core.write>[1]) =>
        tab.run(() => core.write(['chains', HANDLES], change))
    await write(async (tx) => {
        const chain = (await tx.get('chains', session.chainId)) as Record<string, unknown>
        await tx.put('chains', {
            ...chain,
            file: { name: 'coconut.nxsp', event: 'saved', at: 5, hash: head },
        })
    })
    const row = async () => {
        const read = await listRecent({
            call: () => page.tab.run(() => handlersOf(page).listRecent()),
        })
        assert.equal(read.storedRead, 'value')
        const [chain] = read.storedRead === 'value' ? read.storedValue : []
        assert.ok(chain)
        const label = labelOf({
            name: 'Coconut',
            changed: chain.changed,
            writesInPlace: true,
            ...(chain.file ? { file: chain.file } : {}),
        })
        return labelLine({ ...label, name: '' })
    }
    assert.equal(await row(), 'coconut.nxsp')
    // Another chain's picker wrote over the file.
    await write(async (tx) => {
        const { revoked } = await takeOver(tx, {
            owner: {
                chainId: session.chainId,
                role: 'file',
                name: 'coconut.nxsp',
                at: 5,
                handle: false,
            },
            by: 'other',
            at: 10,
        })
        assert.ok(revoked)
    })
    assert.equal(await row(), 'not saved to a file')
})
