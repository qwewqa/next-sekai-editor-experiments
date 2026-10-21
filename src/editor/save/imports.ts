import { isImporting, onImportProgress, whenImported } from '../../local/open/importLoop'
import { storedRead } from '../../local/storedRead'
import type { BuildEnv } from './build'
import { saveUi, type Preparing } from './dialogs'

// The wait for a chain's open imports (Part 1 §1.4.7, spec A): a Save, Save As… and Export wait
// for them in "Preparing…" before they read the chain, and our own completed Save is recorded only
// after them. B and D wait the same way.

/**
 * A Save's "Preparing…": its dialog once opened, and the Save's own cancel, which the dialog's
 * Cancel sets and which outlives the dialog. Every wait the Save makes after it opens ends on it.
 */
export type PreparingSlot = {
    dialog?: Preparing
    name: string
    /** Export's picker waiting for an open's import (SF3-1). */
    kind?: 'export'
    timer?: ReturnType<typeof setTimeout>
    cancel: AbortController
}

export const openPreparing = (slot: PreparingSlot) => {
    if (slot.dialog) return slot.dialog
    const dialog = saveUi.preparing(slot.name, slot.kind)
    slot.dialog = dialog
    if (dialog.signal.aborted) slot.cancel.abort()
    else
        dialog.signal.addEventListener('abort', () => {
            slot.cancel.abort()
        })
    return dialog
}

/** How long a Save waits for a reload's import resume to start (§1.5.4), as a slot load does. */
export const RESUME_WAIT_MS = 4000
export const RESUME_POLL_MS = 250

/** Resolves true after `ms`, or false at once when `signal` aborts. */
export const pause = (ms: number, signal?: AbortSignal) =>
    new Promise<boolean>((resolve) => {
        if (signal?.aborted) {
            resolve(false)
            return
        }
        const stop = () => {
            clearTimeout(timer)
            resolve(false)
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', stop)
            resolve(true)
        }, ms)
        signal?.addEventListener('abort', stop, { once: true })
    })

/**
 * Waits for every import of env's chain that storage lists with `importPending`: one running in
 * this tab with its progress in "Preparing…", one running nowhere here polled for up to
 * RESUME_WAIT_MS. A list that can't be read counts as pending: it is read again within the same
 * bound. At the bound the result is 'done' and the caller does what it does while an import is
 * still pending (the build's `importing` refusal, `recordOwnSave`'s check). 'unlinked' only when
 * the open session's own import ended unlinked.
 */
export const waitForChainImports = async (
    env: Pick<BuildEnv, 'worker' | 'session'> & { chainId: string },
    slot: PreparingSlot,
): Promise<'done' | 'cancelled' | 'unlinked'> => {
    for (let waited = 0; ;) {
        const listed = await storedRead(env.worker, 'openPendingImports', undefined)
        const pending =
            listed.storedRead === 'failed'
                ? undefined
                : listed.storedValue.filter((each) => each.chainId === env.chainId)
        if (pending && !pending.length) return 'done'
        const here = pending?.find((each) => isImporting(each.sessionId))
        if (!here) {
            if (waited >= RESUME_WAIT_MS) return 'done'
            openPreparing(slot)
            if (!(await pause(RESUME_POLL_MS, slot.cancel.signal))) return 'cancelled'
            waited += RESUME_POLL_MS
            continue
        }
        const dialog = openPreparing(slot)
        // The import's progress, from the batches it has run (§1.4.7).
        const stop = onImportProgress(here.sessionId, (progress) => {
            dialog.importing(progress)
        })
        try {
            const outcome = await whenImported(here.sessionId, slot.cancel.signal)
            if (outcome.kind === 'unlinked' && here.sessionId === env.session.id) return 'unlinked'
        } catch {
            return 'cancelled'
        } finally {
            stop()
        }
    }
}
