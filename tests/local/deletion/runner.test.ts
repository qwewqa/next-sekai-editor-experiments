import assert from 'node:assert/strict'
import test from 'node:test'
import { markDeleted, type SweepResult } from '../../../src/local/deletion'
import { createRunner, persistStorage, startMaintenance } from '../../../src/local/maintenance'
import type { PressureRun } from '../../../src/local/pressure'

// The maintenance runner: when the deleting jobs run.

const setup = ({ persist }: { persist?: () => unknown } = {}) => {
    const timers: { at: number; fn: () => void }[] = []
    const clock = { now: 0, visible: true }
    const log: string[] = []
    const sweeps: SweepResult[] = []
    const passes: { kind: string }[] = []
    /** What the pressure checks answer, in turn; not busy when empty. */
    const pressures: PressureRun[] = []
    let hold: Promise<void> = Promise.resolve()
    const runner = createRunner({
        worker: {
            call: (method) => {
                log.push(String(method))
                return Promise.resolve(passes.shift() ?? { kind: 'skipped' })
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
            return persist ? persist() : new Promise(() => undefined)
        },
        pressure: {
            atLoad: () => {
                log.push('atLoad')
                return Promise.resolve(pressures.shift())
            },
            whenFull: () => {
                log.push('whenFull')
                return Promise.resolve(
                    pressures.shift() ?? { trigger: 'full', freed: 0, busy: false },
                )
            },
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
        passes,
        pressures,
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

test("the load's run finishes with persist() never answering, and only the load asks for it", async () => {
    const { runner, log } = setup()
    await runner.start()
    assert.deepEqual(log, ['reclaim', 'sweep', 'gcPass', 'atLoad', 'persist'])
    await runner.trigger()
    assert.equal(log.filter((each) => each === 'persist').length, 1)
})

test('a persist() that rejects or throws changes nothing', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
        for (const persist of [
            () => Promise.reject(new Error('Denied')),
            () => {
                throw new TypeError('Not allowed')
            },
        ]) {
            const { runner, log } = setup({ persist })
            await runner.start()
            assert.deepEqual(log, ['reclaim', 'sweep', 'gcPass', 'atLoad', 'persist'])
            await runner.trigger()
            assert.equal(log.filter((each) => each === 'sweep').length, 2)
        }
        await new Promise((resolve) => setImmediate(resolve))
        assert.deepEqual(unhandled, [])
    } finally {
        process.off('unhandledRejection', onUnhandled)
    }
})

test('persist() is asked for wherever the browser has it, Firefox included', () => {
    const asked: string[] = []
    const answer = Promise.resolve(false)
    assert.equal(
        persistStorage({
            persist: () => {
                asked.push('persist')
                return answer
            },
        }),
        answer,
    )
    assert.deepEqual(asked, ['persist'])
    assert.equal(persistStorage({}), undefined)
    assert.equal(persistStorage(undefined), undefined)
})

test("the pressure check follows GC at load only, and a full browser's cleanup runs on its own trigger", async () => {
    const { runner, log } = setup()
    await runner.start()
    await runner.trigger()
    assert.deepEqual(
        log.filter((each) => each === 'atLoad' || each === 'whenFull'),
        ['atLoad'],
    )
    log.length = 0
    await runner.full()
    assert.deepEqual(log, ['reclaim', 'sweep', 'gcPass', 'whenFull'])
    log.length = 0
    // Paused full already when the runner starts: the load's run does both.
    const already = setup()
    await already.runner.start(true)
    assert.deepEqual(already.log, ['reclaim', 'sweep', 'gcPass', 'atLoad', 'whenFull', 'persist'])
})

test('a busy cleanup is owed and tried again 30 s later', async () => {
    const { runner, log, pressures, advance } = setup()
    pressures.push({ trigger: 'full', freed: 0, busy: true })
    await runner.full()
    assert.equal(log.filter((each) => each === 'whenFull').length, 1)
    await advance(30_000)
    assert.equal(log.filter((each) => each === 'whenFull').length, 2)
    await advance(60_000)
    assert.equal(log.filter((each) => each === 'whenFull').length, 2, 'done: no further try')
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

test('a load that arrives during a run keeps its pressure check and persist() for the queued run', async () => {
    const { runner, log, holdSweep } = setup()
    const release = holdSweep()
    // Storing paused full before the load's idle: its run is going when the load arrives.
    const first = runner.full()
    void runner.start()
    release()
    await first
    assert.equal(log.filter((each) => each === 'sweep').length, 2)
    assert.equal(log.filter((each) => each === 'atLoad').length, 1)
    assert.equal(log.filter((each) => each === 'persist').length, 1)
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

test("a Delete's sweep runs when its mark is old enough", async () => {
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

test('GC is asked for after every sweep, and a busy or stopped pass is tried again 30 s later', async () => {
    for (const kind of ['busy', 'aborted']) {
        const { runner, log, sweeps, passes, advance } = setup()
        // A sweep that removed something: the runner's one GC call follows it.
        sweeps.push({ removed: 1, busy: false })
        passes.push({ kind })
        await runner.trigger()
        assert.deepEqual(log, ['reclaim', 'sweep', 'gcPass'], kind)
        await advance(29_999)
        assert.equal(log.filter((each) => each === 'gcPass').length, 1, kind)
        await advance(1)
        assert.equal(log.filter((each) => each === 'gcPass').length, 2, kind)
        // Done this time: no further try.
        await advance(60_000)
        assert.equal(log.filter((each) => each === 'gcPass').length, 2, kind)
    }
})

test("a load in a hidden page runs nothing but persist(); the page's first visibility runs the jobs and the load's pressure check", async () => {
    const { runner, log, clock } = setup()
    clock.visible = false
    await runner.start()
    assert.deepEqual(log, ['persist'])
    clock.visible = true
    await runner.visible()
    assert.deepEqual(
        log,
        ['persist', 'reclaim', 'sweep', 'gcPass', 'atLoad'],
        'persist is asked for once',
    )
})

test('without Web Locks no job runs, no listener is added, and Delete reports failed', async () => {
    const navigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    const listeners: string[] = []
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true })
    Object.defineProperty(globalThis, 'document', {
        value: {
            addEventListener: (type: string) => listeners.push(type),
            visibilityState: 'visible',
        },
        configurable: true,
    })
    try {
        const calls: string[] = []
        const maintenance = startMaintenance({
            worker: {
                call: (method) => {
                    calls.push(String(method))
                    return Promise.resolve(undefined)
                },
                status: { mode: 'stored', reason: 'full' },
                onStatus: () => {
                    listeners.push('status')
                },
            },
            locks: {
                request: () => Promise.reject(new Error('No locks')),
                query: () => Promise.reject(new Error('No locks')),
            },
            journal: { read: () => Promise.resolve([]) } as never,
            replayJournal: () => Promise.resolve(undefined),
            reclaim: () => Promise.resolve(),
        })
        await maintenance.start()
        assert.deepEqual(calls, [])
        assert.deepEqual(listeners, [])
        assert.deepEqual(await markDeleted('c'), { kind: 'failed' })
    } finally {
        if (navigator) Object.defineProperty(globalThis, 'navigator', navigator)
        Reflect.deleteProperty(globalThis, 'document')
    }
})
