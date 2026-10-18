import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorld, type World } from '../../../src/local/testing/world'
import { readTimeline } from '../../../src/local/worker/timelineHandlers'
import { openPage, type Page } from '../flush/harness'
import { goldenChart, stateOf } from '../records/charts'
import { widen } from '../timeline/helpers'
import { beginIn, continueIn, readOpen } from './harness'

// The History panel's Timeline read (Part 1 §1.4.10.5): a session's entries newest first, a page
// at a time, on into the session it continued at the entry it continued from.

const read = (page: Page, request: Parameters<typeof readTimeline>[1]) =>
    page.tab.run(() => page.core.read(['sessions', 'entries'], (tx) => readTimeline(tx, request)))

/** A stored session of an import and three edits, then a continuation with two of its own. */
const chain = async (world: World) => {
    const page = await openPage(world, world.tab('first'))
    let state = stateOf(goldenChart())
    const parent = beginIn(page, state)
    for (const label of ['One', 'Two', 'Three']) {
        state = widen(state)
        page.flusher.append('edit', () => label, state, true)
    }
    await page.flusher.flush({ strict: true })
    const next = await openPage(world, world.tab('next'))
    const opened = await readOpen(next, parent.id)
    const child = continueIn(next, opened)
    for (const label of ['Four', 'Five']) {
        state = widen(state)
        next.flusher.append('edit', () => label, state, true)
    }
    await next.flusher.flush({ strict: true })
    return { page, next, parent, child }
}

test('a session’s entries come newest first, then the parent’s from where it was continued', async () => {
    const world = createWorld({ seed: 1 })
    const { next, parent, child } = await chain(world)
    const page = await read(next, { sessionId: child.id, limit: 100 })
    assert.deepEqual(
        page.entries.map((entry) => `${entry.kind} ${entry.label}`),
        [
            'edit Five',
            'edit Four',
            'continue Continued',
            'edit Three',
            'edit Two',
            'edit One',
            'init '.trimEnd(),
        ]
            .map((text) => text)
            .slice(0, 6)
            .concat([page.entries[6] ? `${page.entries[6].kind} ${page.entries[6].label}` : '']),
    )
    assert.equal(page.next, undefined)
    // The continue entry names the time of the parent's entry it continued from.
    const continued = page.entries.find((entry) => entry.kind === 'continue')
    const last = page.entries.find((entry) => entry.sessionId === parent.id)
    assert.equal(continued?.from, last?.time)
    assert.equal(continued?.sessionId, child.id)
    assert.ok(page.entries.every((entry) => entry.kept && entry.snapshot.length === 32))
})

test('pages continue where the last ended, across the divider', async () => {
    const world = createWorld({ seed: 1 })
    const { next, child } = await chain(world)
    const seen: string[] = []
    let request: Parameters<typeof readTimeline>[1] | undefined = { sessionId: child.id, limit: 2 }
    let pages = 0
    while (request) {
        const page = await read(next, request)
        seen.push(...page.entries.map((entry) => `${entry.sessionId}:${entry.seq}`))
        request = page.next ? { ...page.next, limit: 2 } : undefined
        pages++
    }
    const all = await read(next, { sessionId: child.id, limit: 100 })
    assert.deepEqual(
        seen,
        all.entries.map((entry) => `${entry.sessionId}:${entry.seq}`),
    )
    assert.ok(pages >= 3)
})
