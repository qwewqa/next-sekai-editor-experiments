import assert from 'node:assert/strict'
import test from 'node:test'
import { retryStoringWith, type RetryWorker } from '../../src/local/retryStoring'
import { createWorld } from '../../src/local/testing/world'
import type { TestFlags } from '../../src/local/worker/core'
import { originOperation } from '../helpers/historySteps'
import { openPage, rows, testId, type Page } from './flush/harness'
import { goldenChart, stateOf } from './records/charts'

// Try Again for storing (Part 1 §1.6.7) over the real storage core: asking the worker again does
// not write anything, so a pause only ends when the pending entries are sent.

const workerOf = (page: Page): RetryWorker => ({
    call: (_method, _arg) => page.tab.run(() => page.core.tryAgain()),
    get status() {
        return page.core.status
    },
})

const pausedPage = async (flags: TestFlags) => {
    const world = createWorld({ seed: 31 })
    const page = await openPage(world, world.tab('a'), {}, { flags })
    const state = stateOf(goldenChart())
    page.flusher.begin({
        id: testId(),
        docId: testId(),
        origin: 'import',
        state,
        operation: originOperation('import'),
        dirty: false,
    })
    await page.flusher.flush()
    return { world, page }
}

test('Try Again while storage is still full leaves it paused with the entries kept', async () => {
    const flags: TestFlags = { forceQuota: true }
    const { world, page } = await pausedPage(flags)
    assert.deepEqual(page.core.status, { mode: 'stored', reason: 'full' })
    assert.equal(page.flusher.hasPending, true)
    const status = await retryStoringWith(workerOf(page), page.flusher)
    assert.deepEqual(status, { mode: 'stored', reason: 'full' })
    assert.equal(page.flusher.hasPending, true)
    assert.equal(rows(world, 'sessions').size, 0)
})

test('Try Again once space is free stores what was pending and ends the pause', async () => {
    const flags: TestFlags = { forceQuota: true }
    const { world, page } = await pausedPage(flags)
    assert.equal(page.core.status.reason, 'full')
    flags.forceQuota = false
    // The worker alone writes nothing: it stays paused with the entries in memory.
    await page.tab.run(() => page.core.tryAgain())
    assert.equal(page.core.status.reason, 'full')
    assert.equal(rows(world, 'sessions').size, 0)
    const status = await retryStoringWith(workerOf(page), page.flusher)
    assert.deepEqual(status, { mode: 'stored' })
    assert.equal(page.flusher.hasPending, false)
    assert.equal(rows(world, 'sessions').size, 1)
})

test('a worker that does not answer still flushes and reports the status it has', async () => {
    const flags: TestFlags = { forceQuota: true }
    const { page } = await pausedPage(flags)
    flags.forceQuota = false
    const worker: RetryWorker = {
        call: () => Promise.reject(new Error('timed out')),
        get status() {
            return page.core.status
        },
    }
    assert.deepEqual(await retryStoringWith(worker, page.flusher), { mode: 'stored' })
    assert.equal(page.flusher.hasPending, false)
})
