import { ExtensionType } from 'pixi.js'

type Task = {
    callback: (elapsed: number) => void
    duration: number
    offset: number
    start: number
    last: number
}

/**
 * Pixi's GC needs periodic resource and collection cleanup, but the editor owns
 * frame scheduling. Run overdue maintenance when rendering resumes instead of
 * keeping Pixi's system ticker alive while the editor is idle or hidden.
 */
export class RenderingScheduler {
    static extension = { type: ExtensionType.WebGLSystem, name: 'scheduler' }
    private readonly tasks = new Map<number, Task>()
    private nextId = 0
    private offset = 0

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
        for (const task of this.tasks.values()) {
            if (now - task.last < task.duration + task.offset) continue
            task.callback(now - task.start)
            task.last = now
        }
    }

    destroy() {
        this.tasks.clear()
    }
}
