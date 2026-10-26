import { watch } from 'vue'
import { startupGate } from '../../startup/gate'

// The code behind Save, Save As…, Export and Open loads in the background once startup is over,
// so a tab left open across a deploy, or one that goes offline, still has it. A press that finds
// it missing says so (`loadForAction`). A failed prefetch stays silent: the press loads it again.

const loads: (() => Promise<unknown>)[] = [
    () => import('./flow'),
    () => import('./exportPick'),
    () => import('../commands/exportLevel/build'),
    () => import('../commands/open/project'),
    () => import('../../local/open/project'),
    () => import('../../local/startup/open'),
    () => import('../switch'),
]

let started = false

const run = () => {
    for (const load of loads) load().catch(() => undefined)
}

/** Loads the Save, Export and Open code when the page is idle after startup; once. */
export const prefetchSaveCode = () => {
    if (started) return
    started = true
    const schedule = () => {
        if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 10_000 })
        else setTimeout(run, 1000)
    }
    if (startupGate.phase !== 'opening') {
        schedule()
        return
    }
    const stop = watch(
        () => startupGate.phase,
        (phase) => {
            if (phase === 'opening') return
            stop()
            schedule()
        },
    )
}
