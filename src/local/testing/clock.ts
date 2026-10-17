import type { Timers } from '../locks'
import type { Actor, Scheduler } from '../scheduler'

// The test core's clock (§1.11's test notes): timers that fire only when a test moves the clock,
// each as a task of the actor that set it, on the seeded scheduler. So a seed replays their order
// with everything else, and the crash sweep can kill at them.

type Timer = { due: number; seq: number; actor: Actor; fn: () => void }

export class FakeClock {
    private time: number
    private next = 1
    private readonly timers = new Map<number, Timer>()

    constructor(
        private readonly scheduler: Scheduler,
        start = 1_000_000,
    ) {
        this.time = start
    }

    now() {
        return this.time
    }

    /** Timers for one actor: setTimeout and clearTimeout, as `Timers` and the flusher take them. */
    for(actor: Actor): Timers & { now: () => number } {
        return {
            setTimeout: (fn, ms) => this.set(actor, fn, ms),
            clearTimeout: (handle) => {
                this.timers.delete(handle as number)
            },
            now: () => this.time,
        }
    }

    private set(actor: Actor, fn: () => void, ms: number) {
        const id = this.next++
        this.timers.set(id, { due: this.time + Math.max(ms, 0), seq: id, actor, fn })
        return id
    }

    /** Timers not yet fired, of actors still alive. */
    get pending() {
        return [...this.timers.values()].filter((timer) => timer.actor.alive).length
    }

    private earliest() {
        let first: [number, Timer] | undefined
        for (const entry of this.timers) {
            if (!entry[1].actor.alive) {
                this.timers.delete(entry[0])
                continue
            }
            if (!first || entry[1].due < first[1].due) first = entry
        }
        return first
    }

    private fire([id, timer]: [number, Timer]) {
        this.timers.delete(id)
        this.time = Math.max(this.time, timer.due)
        this.scheduler.post(timer.actor, this.scheduler.lane(), timer.fn)
    }

    /** Moves the clock forward, firing each timer due on the way, in order, then running to idle. */
    async advance(ms: number) {
        const end = this.time + ms
        for (;;) {
            await this.scheduler.idle()
            const first = this.earliest()
            if (!first || first[1].due > end) break
            this.fire(first)
        }
        this.time = Math.max(this.time, end)
    }

    /** Runs until no task is queued and no timer is set, moving the clock to each next timer. */
    async run(limit = 10_000) {
        for (let fired = 0; ; fired++) {
            await this.scheduler.idle()
            const first = this.earliest()
            if (!first) return
            if (fired >= limit) throw new Error('The clock kept setting timers')
            this.fire(first)
        }
    }
}
