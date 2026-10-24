import { ExtensionType } from 'pixi.js'

type Task = {
    callback: (elapsed: number) => void
    duration: number
    offset: number
    start: number
    last: number
}

/** What the scheduler uses of its renderer: Pixi's GC and its context. */
type Host = {
    // Pixi's GC tasks only mark a pass due; its `postrender` runs a pass that is due.
    gc?: { postrender(): void; maxUnusedTime: number }
    context?: { isLost: boolean }
}

/** When any renderer last rendered, and since when renders have come without a quiet period. */
export type Activity = { last: number; since: number }

/** No render on any renderer for this long: drawing, playback included, has stopped. */
export const QUIET_MS = 1000
/** Due maintenance runs at the next idle period once unbroken drawing has gone on this long. */
export const CEILING_MS = 60_000

const sharedActivity: Activity = { last: -Infinity, since: -Infinity }

const requestIdle = (run: () => void) => {
    if (typeof requestIdleCallback === 'function') {
        const id = requestIdleCallback(run)
        return () => {
            cancelIdleCallback(id)
        }
    }
    const id = setTimeout(run, 0)
    return () => {
        clearTimeout(id)
    }
}

/**
 * Pixi's GC needs periodic resource and collection cleanup, but the editor owns
 * frame scheduling, and a GC pass walks every tracked resource: tens of ms late in a
 * session. Due maintenance runs at idle time, never inside a frame: after `QUIET_MS`
 * with no render on any renderer, or `CEILING_MS` after the later of its due time and
 * the start of renders without such a pause. Nothing is scheduled before a render,
 * and no ticker runs.
 */
export class RenderingScheduler {
    static extension = { type: ExtensionType.WebGLSystem, name: 'scheduler' }
    private readonly tasks = new Map<number, Task>()
    private nextId = 0
    private offset = 0
    private rendered = -Infinity
    private timer?: ReturnType<typeof setTimeout>
    private cancelIdle?: () => void
    private destroyed = false

    /** Pixi passes the renderer; tests pass their own activity record. */
    constructor(
        private readonly renderer?: Host,
        private readonly activity = sharedActivity,
    ) {}

    repeat(callback: (elapsed: number) => void, duration: number, useOffset = true) {
        const id = ++this.nextId
        const now = performance.now()
        this.tasks.set(id, {
            callback,
            duration,
            offset: useOffset ? (this.offset += 1000) : 0,
            start: now,
            last: now,
        })
        return id
    }

    cancel(id: number) {
        this.tasks.delete(id)
    }

    prerender() {
        const now = performance.now()
        const { activity } = this
        if (now - activity.last >= QUIET_MS) activity.since = now
        this.rendered = activity.last = now
        if (!this.timer && !this.cancelIdle) this.check()
    }

    private due() {
        let due = Infinity
        for (const task of this.tasks.values())
            due = Math.min(due, task.last + task.duration + task.offset)
        return due
    }

    /** When maintenance due at `due` may run: at a quiet period, or at the ceiling. */
    private runAt(due: number) {
        const { last, since } = this.activity
        return Math.max(due, Math.min(last + QUIET_MS, Math.max(due, since) + CEILING_MS))
    }

    // A GC pass unloads what was unused for `maxUnusedTime`. Within half of that
    // after this renderer's last render, it keeps everything that render used.
    private fresh(time: number) {
        return time - this.rendered < (this.renderer?.gc?.maxUnusedTime ?? 60_000) / 2
    }

    private readonly check = () => {
        this.timer = undefined
        const due = this.due()
        if (this.destroyed || due === Infinity) return
        const at = this.runAt(due)
        // Too long after the last render: the next render arms it again.
        if (!this.fresh(at)) return
        const wait = at - performance.now()
        if (wait > 0) this.timer = setTimeout(this.check, wait)
        else this.cancelIdle = requestIdle(this.maintain)
    }

    private readonly maintain = () => {
        this.cancelIdle = undefined
        // A render after restoration arms it again.
        if (this.destroyed || this.renderer?.context?.isLost) return
        const now = performance.now()
        if (!this.fresh(now)) return
        // Renders came after the check.
        if (now < this.runAt(this.due())) {
            this.check()
            return
        }
        for (const task of this.tasks.values()) {
            if (now - task.last < task.duration + task.offset) continue
            task.callback(now - task.start)
            task.last = now
        }
        this.renderer?.gc?.postrender()
        this.check()
    }

    destroy() {
        this.destroyed = true
        clearTimeout(this.timer)
        this.cancelIdle?.()
        this.timer = undefined
        this.cancelIdle = undefined
        this.tasks.clear()
    }
}
