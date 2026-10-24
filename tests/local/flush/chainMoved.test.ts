import assert from 'node:assert/strict'
import test from 'node:test'
import type { FlushSession } from '../../../src/local/flush'
import { createWorld } from '../../../src/local/testing/world'
import { editStep, futureFixtureOperation } from '../../helpers/historySteps'
import '../../helpers/lockChecks'
import { goldenChart, stateOf } from '../records/charts'
import { beginIn, continueIn, readOpen } from '../startup/harness'
import { widen } from '../timeline/helpers'
import { openPage } from './harness'

// Other tabs' Recent Sessions lists change when a chain record is made or its head moves, and only
// then: not on every flush.

const edit = (label: string) => ({
    kind: 'edit' as const,
    step: editStep(futureFixtureOperation(label)),
})

test('a flush tells when it makes the chain or moves its head, not on every flush', async () => {
    const world = createWorld({ seed: 1 })
    const moved: FlushSession[] = []
    const page = await openPage(world, world.tab('a'), {
        onChainMoved: (session) => moved.push(session),
    })
    const a = stateOf(goldenChart())
    const first = beginIn(page, a)
    page.flusher.append(edit('One'), widen(a, 1), true)
    await page.flusher.flush()
    assert.deepEqual(
        moved.map((session) => session.id),
        [first.id],
    )
    // Further flushes of the same session only add entries to the same head.
    page.flusher.append(edit('Two'), widen(a, 2), true)
    await page.flusher.flush()
    page.flusher.append(edit('Three'), widen(a, 3), true)
    await page.flusher.flush({ strict: true })
    assert.equal(moved.length, 1)
    // A continuation stores nothing until it has an entry; its first write moves the head.
    const read = await readOpen(page, first.id)
    const continued = continueIn(page, read)
    await page.flusher.flush()
    assert.equal(moved.length, 1)
    page.flusher.append(edit('Four'), widen(a, 4), true)
    await page.flusher.flush()
    assert.deepEqual(
        moved.map((session) => session.id),
        [first.id, continued.id],
    )
    // A fork's first write makes a chain of its own.
    const forkRead = await readOpen(page, continued.id)
    const fork = continueIn(page, forkRead, { asFork: true })
    page.flusher.append(edit('Five'), widen(a, 5), true)
    await page.flusher.flush()
    assert.equal(moved.at(-1)?.id, fork.id)
    assert.equal(moved.length, 3)
})
