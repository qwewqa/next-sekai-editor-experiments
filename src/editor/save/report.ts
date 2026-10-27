import { busy, chartChanged, record } from '../../analytics/tally'
import type { Outcome } from './flow'

// The usage statistics' `save` event: one per Save-family action, recorded where the action ends.
// The facts gather in a module value while it runs (the action, the options, where it wrote), so
// the many paths of `flow.ts` each add a line rather than a parameter. One action runs at a time.

type Action = 'save' | 'saveAs' | 'saveToFile' | 'downloadAgain'
type Facts = {
    action: Action
    history: boolean
    bgm: boolean
    target?: 'writeBack' | 'picker' | 'download'
    size?: number
    buildMs?: number
    /** When the write began, after the last picker and dialog closed. */
    since?: number
}

let current: Facts | undefined

/** An action begins. A second call (the dialog's answer) replaces the facts. */
export const startSave = (action: Action, options = { history: true, bgm: true }) => {
    if (!current) busy(true)
    current = { action, ...options }
}

/** The write begins, after the last picker or dialog has closed. */
export const startWrite = (target: NonNullable<Facts['target']>) => {
    if (current) Object.assign(current, { target, since: performance.now() })
}

/** How long the file took to build, in milliseconds; a rebuild after a failure replaces it. */
export const builtIn = (ms: number) => {
    if (current) current.buildMs = ms
}

/** What was written, in bytes. */
export const savedSize = (size: number) => {
    if (current) current.size = size
}

/** The action ends. Without an outcome, it ended at a dialog or a refusal that wrote nothing. */
export const finishSave = (outcome?: Outcome | { kind: 'noChanges' }) => {
    if (!current) return
    const { action, history, bgm, target, size, buildMs, since } = current
    current = undefined
    busy(false)
    if (outcome?.kind === 'done') chartChanged('save')
    const failed = outcome?.kind === 'failed' ? outcome.error : undefined
    record(
        'save',
        {
            action,
            history,
            bgm,
            ...(target && { target }),
            ...(size !== undefined && { size }),
            ...(buildMs !== undefined && { buildMs }),
            outcome: outcome?.kind ?? 'cancelled',
            ...(failed && { reason: failed.code }),
            ...(outcome?.kind === 'refused' && { reason: outcome.reason }),
            ...(failed?.step && { step: failed.step }),
        },
        since,
    )
}

/** Runs an action, and ends it when it returns. */
export const tracked = async (action: Action, run: () => Promise<void>) => {
    startSave(action)
    try {
        await run()
    } finally {
        finishSave()
    }
}
