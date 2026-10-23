import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { DeleteDeps } from '../../src/editor/history/sessionDelete'
import type { Mark, MarkDeletedResult, UndoDeletedResult } from '../../src/local/deletion'
import type { RecentChain } from '../../src/local/recent'

// The catalogues are collected with Vite's import.meta.glob and settings read the browser: a load
// hook swaps them for the English catalogue and a settings object with only the locale.
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

const { createDeleteModel } = await import('../../src/editor/history/sessionDelete')

// Delete's UI model (Part 1 §1.4.10.6): marks, the inline Undo rows, Undo's three outcomes and the
// live announcement, with fakes for the page.

const chain = (id: string): RecentChain => ({
    chainId: id,
    updatedAt: 1000,
    head: { sessionId: `${id}-head`, lastSeq: 1, startedAt: 500 },
    nameParts: {},
    changed: false,
    readable: 'yes',
})

const ids = (marks: Mark[][]) => marks.map((each) => each.map((mark) => mark.chainId))

const setup = () => {
    const log = {
        marked: [] as string[],
        undone: [] as Mark[][],
        changed: 0,
        peeks: [] as string[],
        reports: [] as string[],
    }
    const fakes = {
        mark: (chainId: string): Promise<MarkDeletedResult> =>
            Promise.resolve({ kind: 'marked', mark: { chainId, at: 5 } }),
        undo: (marks: Mark[]): Promise<UndoDeletedResult> =>
            Promise.resolve({
                kind: 'done',
                restored: marks.map((mark) => mark.chainId),
                lost: [],
            }),
    }
    const deps: DeleteDeps = {
        mark: (id) => {
            log.marked.push(id)
            return fakes.mark(id)
        },
        undo: (marks) => {
            log.undone.push(marks)
            return fakes.undo(marks)
        },
        report: (message) => log.reports.push(message()),
        changed: () => log.changed++,
        endPeek: (id) => log.peeks.push(id),
    }
    const model = createDeleteModel(deps)
    model.listShown(true)
    return { model, fakes, log }
}

const statuses = (model: ReturnType<typeof setup>['model']) =>
    [...model.inline.value.entries()].map(([id, entry]) => [id, entry.status])

test('a Delete makes an inline row, announces it and tells the lists; no notice is raised', async () => {
    const t = setup()
    assert.equal(await t.model.remove(chain('a'), 'Alpha'), 'marked')
    assert.deepEqual(statuses(t.model), [['a', 'deleted']])
    assert.equal(t.model.announcement.value, 'Deleted "Alpha"')
    assert.equal(t.log.changed, 1)
    assert.deepEqual(t.log.reports, [])
    // Further Deletes each have their own row.
    await t.model.remove(chain('b'), 'Beta')
    assert.deepEqual(statuses(t.model), [
        ['a', 'deleted'],
        ['b', 'deleted'],
    ])
})

test('Undo brings the row back and tells the lists', async () => {
    const t = setup()
    await t.model.remove(chain('a'), 'Alpha')
    await t.model.remove(chain('b'), 'Beta')
    const changed = t.log.changed
    await t.model.undo('a')
    assert.deepEqual(statuses(t.model), [['b', 'deleted']])
    assert.deepEqual(ids(t.log.undone), [['a']])
    assert.ok(t.log.changed > changed, 'the lists read again')
})

test('Undo of a chain the sweep removed says it can no longer be undone, once, and offers no Undo again', async () => {
    const t = setup()
    await t.model.remove(chain('a'), 'Alpha')
    t.fakes.undo = () => Promise.resolve({ kind: 'done', restored: [], lost: ['a'] })
    await t.model.undo('a')
    assert.deepEqual(statuses(t.model), [['a', 'lost']])
    assert.equal(t.model.announcement.value, 'Deleted "Alpha". It can no longer be undone.')
    t.log.undone.length = 0
    await t.model.undo('a')
    assert.deepEqual(t.log.undone, [])
})

test('a failed Undo keeps the mark: the row says so and Try Again undoes the same one', async () => {
    const t = setup()
    await t.model.remove(chain('a'), 'Alpha')
    t.fakes.undo = () => Promise.resolve({ kind: 'failed' })
    await t.model.undo('a')
    assert.deepEqual(statuses(t.model), [['a', 'failed']])
    assert.equal(t.model.announcement.value, 'Undo failed')
    // Storage is back: Try Again.
    t.fakes.undo = (marks) =>
        Promise.resolve({ kind: 'done', restored: marks.map((mark) => mark.chainId), lost: [] })
    t.log.undone.length = 0
    await t.model.undo('a')
    assert.deepEqual(ids(t.log.undone), [['a']])
    assert.equal(t.model.inline.value.size, 0)
})

test('a second Undo while one is under way does nothing', async () => {
    const t = setup()
    await t.model.remove(chain('a'), 'Alpha')
    let release!: () => void
    t.fakes.undo = () =>
        new Promise((resolve) => {
            release = () => resolve({ kind: 'done', restored: ['a'], lost: [] })
        })
    const first = t.model.undo('a')
    await t.model.undo('a')
    release()
    await first
    assert.equal(t.log.undone.length, 1)
})

test('a chain open elsewhere or a failed write is reported and leaves no row; a chain already gone is quiet', async () => {
    const t = setup()
    t.fakes.mark = () => Promise.resolve({ kind: 'open' })
    assert.equal(await t.model.remove(chain('a'), 'Alpha'), 'open')
    assert.deepEqual(t.log.reports, ['Not deleted. "Alpha" is open in another tab or window.'])
    t.fakes.mark = () => Promise.resolve({ kind: 'failed' })
    assert.equal(await t.model.remove(chain('a'), 'Alpha'), 'failed')
    assert.equal(t.log.reports.at(-1), 'Could not delete "Alpha"')
    t.fakes.mark = () => Promise.resolve({ kind: 'gone' })
    const reports = t.log.reports.length
    const changed = t.log.changed
    assert.equal(await t.model.remove(chain('a'), 'Alpha'), 'gone')
    assert.equal(t.log.reports.length, reports, 'no notice')
    assert.equal(t.log.changed, changed + 1, 'the list reads again')
    assert.equal(t.model.inline.value.size, 0)
    // A refused chain can be tried again: nothing was held.
    t.fakes.mark = (chainId) => Promise.resolve({ kind: 'marked', mark: { chainId, at: 9 } })
    assert.equal(await t.model.remove(chain('a'), 'Alpha'), 'marked')
})

test('a second press on a chain being deleted is ignored, and its peek ended before the mark', async () => {
    const t = setup()
    let release!: () => void
    t.fakes.mark = (chainId) =>
        new Promise((resolve) => {
            release = () => resolve({ kind: 'marked', mark: { chainId, at: 1 } })
        })
    const first = t.model.remove(chain('a'), 'Alpha')
    assert.equal(await t.model.remove(chain('a'), 'Alpha'), 'busy')
    assert.deepEqual(t.log.peeks, ['a'])
    release()
    assert.equal(await first, 'marked')
    assert.deepEqual(t.log.marked, ['a'])
})

test('closing the lists drops the inline rows', async () => {
    const t = setup()
    await t.model.remove(chain('a'), 'Alpha')
    t.model.listShown(false)
    assert.equal(t.model.inline.value.size, 0)
    assert.equal(t.model.announcement.value, '')
})
