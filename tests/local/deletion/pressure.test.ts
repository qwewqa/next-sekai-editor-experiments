import assert from 'node:assert/strict'
import test from 'node:test'
import type { CleanupResult } from '../../../src/local/cleanup'
import {
    FULL_ROUND_BYTES,
    relieveAtLoad,
    relieveFull,
    type Estimate,
    type PressureDeps,
} from '../../../src/local/pressure'
import type { PauseReason } from '../../../src/local/worker/core'

// When cleanup under pressure runs, on the page (deletion design §3.7): at load above 80% of the
// quota, down to 70%; and after storing paused for a full browser, rounds with Try Again between.

const GB = 1024 ** 3

const fake = ({
    estimate = { usage: 0.5 * GB, quota: GB },
    rounds = [],
    stillFull = 99,
}: {
    estimate?: Estimate | 'fails'
    rounds?: CleanupResult[]
    /** Try Agains that still find the browser full. */
    stillFull?: number
}) => {
    const log: string[] = []
    let paused: PauseReason | undefined = 'full'
    let full = stillFull
    const deps: PressureDeps = {
        removeCachedMedia: (bytes) => {
            log.push(`remove ${String(bytes)}`)
            return Promise.resolve(rounds.shift() ?? { kind: 'removed', bytes: 0, items: 0 })
        },
        estimate: () =>
            estimate === 'fails'
                ? Promise.reject(new Error('No estimate'))
                : Promise.resolve(estimate),
        paused: () => paused,
        retryStoring: () => {
            log.push('retry')
            if (full-- <= 0) paused = undefined
            return Promise.resolve(paused ? { mode: 'stored', reason: paused } : { mode: 'stored' })
        },
    }
    return { deps, log }
}

test('at load nothing is removed while usage is at or under 80% of the quota', async () => {
    for (const estimate of [
        { usage: 0.8 * GB, quota: GB },
        { usage: 0.1 * GB, quota: GB },
        { usage: GB },
        'fails' as const,
    ]) {
        const { deps, log } = fake({ estimate })
        assert.equal(await relieveAtLoad(deps), undefined)
        assert.deepEqual(log, [], JSON.stringify(estimate))
    }
})

test('at load above 80% of the quota, cached media is removed down to 70%, with no Try Again', async () => {
    const { deps, log } = fake({
        estimate: { usage: 0.9 * GB, quota: GB },
        rounds: [{ kind: 'removed', bytes: 1000, items: 1 }],
    })
    assert.deepEqual(await relieveAtLoad(deps), { trigger: 'load', freed: 1000, busy: false })
    assert.deepEqual(log, [`remove ${String(0.9 * GB - 0.7 * GB)}`])
})

test('a full browser: a round, then Try Again, repeated while a round removed something', async () => {
    const { deps, log } = fake({
        rounds: [
            { kind: 'removed', bytes: 10, items: 1 },
            { kind: 'removed', bytes: 20, items: 2 },
        ],
    })
    assert.deepEqual(await relieveFull(deps), { trigger: 'full', freed: 30, busy: false })
    // The third round removed nothing: storing stays paused, with no further Try Again.
    assert.deepEqual(log, [
        `remove ${String(FULL_ROUND_BYTES)}`,
        'retry',
        `remove ${String(FULL_ROUND_BYTES)}`,
        'retry',
        `remove ${String(FULL_ROUND_BYTES)}`,
    ])
})

test('a full browser stops once Try Again resumes storing, or when the removal is busy', async () => {
    const resumed = fake({ rounds: [{ kind: 'removed', bytes: 10, items: 1 }], stillFull: 0 })
    assert.deepEqual(await relieveFull(resumed.deps), { trigger: 'full', freed: 10, busy: false })
    assert.deepEqual(resumed.log, [`remove ${String(FULL_ROUND_BYTES)}`, 'retry'])

    const busy = fake({ rounds: [{ kind: 'busy' }] })
    assert.deepEqual(await relieveFull(busy.deps), { trigger: 'full', freed: 0, busy: true })
    assert.deepEqual(busy.log, [`remove ${String(FULL_ROUND_BYTES)}`])

    const unsafe = fake({ rounds: [{ kind: 'unsafe', why: 'a session of a newer version' }] })
    assert.deepEqual(await relieveFull(unsafe.deps), { trigger: 'full', freed: 0, busy: false })
    assert.deepEqual(unsafe.log, [`remove ${String(FULL_ROUND_BYTES)}`])
})

test('a full browser near its quota frees down to 70% when that is more than one round', async () => {
    const { deps, log } = fake({ estimate: { usage: 0.95 * GB, quota: GB } })
    await relieveFull(deps)
    assert.deepEqual(log, [`remove ${String(0.95 * GB - 0.7 * GB)}`])
})
