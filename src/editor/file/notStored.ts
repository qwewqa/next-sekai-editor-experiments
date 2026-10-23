import { computed, shallowRef, watch, type ComputedRef, type ShallowRef } from 'vue'
import { i18n } from '../../i18n'
import { storageStatus } from '../../local/startup/events'
import type { PauseReason, StorageStatus } from '../../local/worker/core'
import { PRODUCT_NAME } from '../../product'
import { isSafeMode } from '../../safe'
import { interpolateRaw } from '../../utils/interpolate'

// The "Not stored" state (Part 1 §1.6.7): raised from the storage status alone, once a cause has
// held for a moment, so a brief stall never flickers. The chip, the status label, the iOS bar and
// Settings › Local Data all read `notStored`; the per-edit states of the leave prompt
// (`notDurableReason`) are not part of it.

export type NotStoredCause =
    /** Storage is unavailable in this browser. */
    | { kind: 'unavailable' }
    /** A newer database: this build stores nothing. */
    | { kind: 'readOnly' }
    /** Storing is paused, or an upgrade is blocked behind older tabs. */
    | { kind: 'paused'; reason: PauseReason }

/** How long a cause holds before it is shown. */
export const NOT_STORED_DELAY_MS = 3000

/** What a storage status says about storing; undefined while it stores. */
export const causeOf = (status: StorageStatus | undefined): NotStoredCause | undefined => {
    if (!status) return undefined
    if (status.mode === 'readOnly') return { kind: 'readOnly' }
    if (status.reason) return { kind: 'paused', reason: status.reason }
    return status.mode === 'memory' ? { kind: 'unavailable' } : undefined
}

const keyOf = (cause: NotStoredCause | undefined) =>
    cause?.kind === 'paused' ? `paused:${cause.reason}` : cause?.kind

export type NotStoredOptions = {
    status: Readonly<ShallowRef<StorageStatus | undefined>>
    /** Safe mode raises nothing: its bar already says changes are not stored. */
    safe: boolean
    delayMs?: number
}

export type NotStoredState = {
    /** The cause now, from the status alone. */
    notStoredCause: ComputedRef<NotStoredCause | undefined>
    /** The cause once it has held for the delay without a break. */
    notStored: Readonly<ShallowRef<NotStoredCause | undefined>>
}

/**
 * A cause that clears before the delay never shows. One that clears after it lowers at once; a
 * change of reason while shown keeps it shown, and the reason read is the current one.
 */
export const createNotStored = ({
    status,
    safe,
    delayMs = NOT_STORED_DELAY_MS,
}: NotStoredOptions): NotStoredState => {
    const current = shallowRef<NotStoredCause>()
    watch(
        status,
        (next) => {
            const cause = safe ? undefined : causeOf(next)
            if (keyOf(current.value) !== keyOf(cause)) current.value = cause
        },
        { immediate: true, flush: 'sync' },
    )
    const shown = shallowRef<NotStoredCause>()
    let timer: ReturnType<typeof setTimeout> | undefined
    watch(
        current,
        (cause) => {
            if (!cause) {
                clearTimeout(timer)
                timer = undefined
                shown.value = undefined
            } else if (shown.value) {
                shown.value = cause
            } else {
                // A cause that changes while it waits keeps waiting: the wait is unbroken.
                timer ??= setTimeout(() => {
                    timer = undefined
                    shown.value = current.value
                }, delayMs)
            }
        },
        { immediate: true, flush: 'sync' },
    )
    return {
        notStoredCause: computed(() => current.value),
        notStored: shown,
    }
}

const state = createNotStored({ status: storageStatus, safe: isSafeMode() })

/** The cause now, from the storage status alone; undefined in `?safe`. */
export const notStoredCause = state.notStoredCause

/** The cause once it has held for `NOT_STORED_DELAY_MS`; drives the chip, the bar and the line. */
export const notStored = state.notStored

/** Why storing is paused, as a sentence: the one wording for the Not stored dialog and Local Data. */
export const pausedReasonLine = (reason: PauseReason) => {
    const { storage } = i18n.value
    switch (reason) {
        case 'full':
            return storage.reason.full
        case 'failed':
            return storage.reason.failed
        case 'upgrading':
            return storage.reason.upgrading
        case 'olderTabs':
            return interpolateRaw(storage.reason.olderTabs, PRODUCT_NAME)
    }
}
