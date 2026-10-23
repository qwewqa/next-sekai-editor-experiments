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

// Delete's UI model (Part 1 §1.4.10.6): marks, the delete card and its merge, the inline Undo
// rows, and Undo's three outcomes, with fakes for the page.

const chain = (id: string): RecentChain => ({
    chainId: id,
    updatedAt: 1000,
    head: { sessionId: `${id}-head`, lastSeq: 1, startedAt: 500 },
    nameParts: {},
    changed: false,
    readable: 'yes',
})

type Card = {
    id: number
    message: () => string
    action: { label: () => string; run: () => void } | undefined
    severity: string | undefined
}

const ids = (marks: Mark[][]) => marks.map((each) => each.map((mark) => mark.chainId))
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const setup = () => {
    const cards: Card[] = []
    let shown: number | undefined
    const log = {
        marked: [] as string[],
        undone: [] as Mark[][],
        changed: 0,
        peeks: [] as string[],
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
        card: ({ message, action, severity }) => {
            const card = { id: cards.length, message, action, severity }
            cards.push(card)
            shown = card.id
            return card.id
        },
        cardShown: (id) => shown === id,
        closeCard: (id) => {
            if (shown === id) shown = undefined
        },
        changed: () => log.changed++,
        endPeek: (id) => log.peeks.push(id),
    }
    const model = createDeleteModel(deps)
    model.listShown(true)
    return {
        model,
        cards,
        fakes,
        log,
        /** The card on screen. */
        card: () => cards.find((card) => card.id === shown),
        dismiss: () => (shown = undefined),
    }
}

test('a Delete shows its card and an inline row; a second while the card shows merges into it', async () => {
    const t = setup()
    assert.equal(await t.model.remove(chain('a'), 'Alpha'), 'marked')
    assert.equal(t.card()?.message(), 'Deleted "Alpha"')
    assert.deepEqual([...t.model.inline.value.keys()], ['a'])
    assert.equal(await t.model.remove(chain('b'), 'Beta'), 'marked')
    // One card, now for both, and its Undo undoes both.
    assert.equal(t.card()?.message(), 'Deleted 2 sessions')
    assert.deepEqual([...t.model.inline.value.keys()], ['a', 'b'])
    t.card()?.action?.run()
    await settle()
    assert.deepEqual(ids(t.log.undone), [['a', 'b']])
})

test('a Delete after the card has gone starts a card of its own, and the inline rows stay', async () => {
    const t = setup()
    await t.model.remove(chain('a'), 'Alpha')
    t.dismiss()
    await t.model.remove(chain('b'), 'Beta')
    assert.equal(t.card()?.message(), 'Deleted "Beta"')
    assert.deepEqual([...t.model.inline.value.keys()], ['a', 'b'])
})

test('Undo of everything brings the rows back, closes the card and says nothing more', async () => {
    const t = setup()
    await t.model.remove(chain('a'), 'Alpha')
    await t.model.remove(chain('b'), 'Beta')
    const changed = t.log.changed
    await t.model.undo(t.model.cardMarks())
    assert.equal(t.model.inline.value.size, 0)
    assert.equal(t.card(), undefined)
    assert.ok(t.log.changed > changed, 'the lists read again')
    assert.equal(t.cards.length, 2, 'no card after the delete cards')
})

test('Undo of a chain the sweep removed says it can no longer be undone, and the others return', async () => {
    const t = setup()
    await t.model.remove(chain('a'), 'Alpha')
    await t.model.remove(chain('b'), 'Beta')
    t.fakes.undo = () => Promise.resolve({ kind: 'done', restored: ['b'], lost: ['a'] })
    await t.model.undo(['a', 'b'])
    assert.equal(t.card()?.message(), 'Deleted "Alpha". It can no longer be undone.')
    assert.equal(t.card()?.action, undefined)
    // The restored chain's row is back; the lost one stays as text with no Undo.
    assert.deepEqual(
        [...t.model.inline.value.entries()].map(([id, entry]) => [id, entry.status]),
        [['a', 'lost']],
    )
    // A lost chain is not offered Undo again.
    t.log.undone.length = 0
    await t.model.undo(['a'])
    assert.deepEqual(t.log.undone, [])
})

test('several lost chains are counted, without names', async () => {
    const t = setup()
    for (const id of ['a', 'b', 'c']) await t.model.remove(chain(id), id.toUpperCase())
    t.fakes.undo = (marks) =>
        Promise.resolve({ kind: 'done', restored: [], lost: marks.map((mark) => mark.chainId) })
    await t.model.undo(['a', 'b', 'c'])
    assert.equal(t.card()?.message(), 'Deleted 3 sessions. They can no longer be undone.')
})

test('a failed Undo keeps the marks: Try Again undoes the same chains and the rows keep Undo', async () => {
    const t = setup()
    await t.model.remove(chain('a'), 'Alpha')
    await t.model.remove(chain('b'), 'Beta')
    t.fakes.undo = () => Promise.resolve({ kind: 'failed' })
    await t.model.undo(['a', 'b'])
    assert.equal(t.card()?.message(), 'Undo failed')
    assert.equal(t.card()?.action?.label(), 'Try Again')
    assert.deepEqual(
        [...t.model.inline.value.values()].map((entry) => entry.status),
        ['deleted', 'deleted'],
    )
    // Storage is back: Try Again undoes both.
    t.fakes.undo = (marks) =>
        Promise.resolve({ kind: 'done', restored: marks.map((mark) => mark.chainId), lost: [] })
    t.log.undone.length = 0
    t.card()?.action?.run()
    await settle()
    assert.deepEqual(ids(t.log.undone), [['a', 'b']])
    assert.equal(t.model.inline.value.size, 0)
})

test('an inline Undo of one chain leaves the card for the other', async () => {
    const t = setup()
    await t.model.remove(chain('a'), 'Alpha')
    await t.model.remove(chain('b'), 'Beta')
    await t.model.undo(['a'])
    assert.equal(t.card()?.message(), 'Deleted "Beta"')
    assert.deepEqual([...t.model.inline.value.keys()], ['b'])
})

test('a chain open elsewhere or a failed write is reported and leaves no row; a chain already gone is quiet', async () => {
    const t = setup()
    t.fakes.mark = () => Promise.resolve({ kind: 'open' })
    assert.equal(await t.model.remove(chain('a'), 'Alpha'), 'open')
    assert.equal(t.card()?.message(), 'Not deleted. "Alpha" is open in another tab or window.')
    assert.equal(t.card()?.severity, 'error')
    t.fakes.mark = () => Promise.resolve({ kind: 'failed' })
    assert.equal(await t.model.remove(chain('a'), 'Alpha'), 'failed')
    assert.equal(t.card()?.message(), 'Could not delete "Alpha"')
    t.fakes.mark = () => Promise.resolve({ kind: 'gone' })
    const cards = t.cards.length
    const changed = t.log.changed
    assert.equal(await t.model.remove(chain('a'), 'Alpha'), 'gone')
    assert.equal(t.cards.length, cards, 'no notice')
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

test('closing the lists drops the inline rows, not the marks: the card still undoes', async () => {
    const t = setup()
    await t.model.remove(chain('a'), 'Alpha')
    t.model.listShown(false)
    assert.equal(t.model.inline.value.size, 0)
    assert.equal(t.card()?.message(), 'Deleted "Alpha"')
    await t.model.undo(t.model.cardMarks())
    assert.deepEqual(ids(t.log.undone), [['a']])
    assert.equal(t.card(), undefined)
})
