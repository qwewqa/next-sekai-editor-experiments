import assert from 'node:assert/strict'
import test from 'node:test'
import type { SweepResult } from '../../../src/local/deletion'
import { createRunner } from '../../../src/local/maintenance'

// The maintenance runner (deletion design §3.10): when the deleting jobs run.

const setup = () => {
    const timers: { at: number; fn: () => void }[] = []
    const clock = { now: 0, visible: true }
    const log: string[] = []
    const sweeps: SweepResult[] = []
    let hold: Promise<void> = Promise.resolve()
    const runner = createRunner({
        worker: {
            call: (method) => {
                log.push(String(method))
                return Promise.resolve({ kind: 'skipped' })
            },
        },
        sweep: async () => {
            log.push('sweep')
            await hold
            return sweeps.shift() ?? { removed: 0, busy: false }
        },
        reclaim: () => {
            log.push('reclaim')
            return Promise.resolve()
        },
        persist: () => {
            log.push('persist')
            // Firefox's prompt, never answered.
            return new Promise(() => undefined)
        },
        visible: () => clock.visible,
        timers: {
            setTimeout: (fn, ms) => {
                const timer = { at: clock.now + ms, fn }
                timers.push(timer)
                return timer
            },
            clearTimeout: (handle) => {
                timers.splice(timers.indexOf(handle as (typeof timers)[number]), 1)
            },
        },
        now: () => clock.now,
    })
    const advance = async (ms: number) => {
        clock.now += ms
        for (const timer of timers.filter((each) => each.at <= clock.now)) {
            timers.splice(timers.indexOf(timer), 1)
            timer.fn()
        }
        await new Promise((resolve) => setImmediate(resolve))
    }
    return {
        runner,
        log,
        sweeps,
        clock,
        timers,
        advance,
        holdSweep: () => {
            let release!: () => void
            hold = new Promise((resolve) => (release = resolve))
            return () => {
                release()
            }
        },
    }
}

test('the load’s run finishes with persist() never answering, and only the load asks for it', async () => {
    const { runner, log } = setup()
    await runner.start()
    assert.deepEqual(log, ['reclaim', 'sweep', 'gcPass', 'persist'])
    await runner.trigger()
    assert.equal(log.filter((each) => each === 'persist').length, 1)
})

test('a trigger during a run queues one more run, not one per trigger', async () => {
    const { runner, log, holdSweep } = setup()
    const release = holdSweep()
    const first = runner.trigger()
    void runner.trigger()
    void runner.trigger()
    release()
    await first
    assert.equal(log.filter((each) => each === 'sweep').length, 2)
})

test('a busy run tries again 30 s later; a hidden page waits until it is visible', async () => {
    const { runner, log, sweeps, clock, advance } = setup()
    sweeps.push({ removed: 0, busy: true })
    await runner.trigger()
    clock.visible = false
    await advance(30_000)
    assert.equal(log.filter((each) => each === 'sweep').length, 1)
    clock.visible = true
    // Visible again within the minute: the run owed while hidden goes now.
    await runner.visible()
    assert.equal(log.filter((each) => each === 'sweep').length, 2)
    await runner.visible()
    assert.equal(log.filter((each) => each === 'sweep').length, 2, 'at most once a minute')
})

test('a Delete’s sweep runs when its mark is old enough', async () => {
    const { runner, log, advance } = setup()
    runner.sweepAt(600_000)
    runner.sweepAt(300_000)
    await advance(299_999)
    assert.deepEqual(log, [])
    await advance(1)
    assert.equal(log.filter((each) => each === 'sweep').length, 1)
    await advance(300_000)
    assert.equal(log.filter((each) => each === 'sweep').length, 2)
})
