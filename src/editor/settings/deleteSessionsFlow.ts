import { computed, shallowRef } from 'vue'
import { i18n } from '../../i18n'
import type { DeleteChain } from '../../local/deleteSessions'
import { storageStatus } from '../../local/startup/events'
import { showModal } from '../../modals'
import { showChoice } from '../../modals/choice'
import LoadingModal from '../../modals/LoadingModal.vue'
import { isSafeMode } from '../../safe'
import { interpolate } from '../../utils/interpolate'
import { causeOf } from '../file/notStored'
import { pausedReasonLine } from '../file/notStoredReason'
import { backToNow, peekedSession } from '../history/selection'
import { deleteChanged } from '../history/sessionsChanged'
import { notify } from '../notification'
import { shownName } from '../shownName'
import { confirmLines } from './deleteChoices'
import DeleteSessionsDialog from './DeleteSessionsDialog.vue'

// Delete Sessions…, one flow for every way in: Settings › Local Data, the History band on Recent
// Sessions and the command. The removal, the reclaim and GC are `local/deleteSessions`.

/** Delete Sessions… acts on the stored database: not in safe mode, not while another tab upgrades it. */
export const canDeleteSessions = computed(() => {
    const status = storageStatus.value
    return !isSafeMode() && status?.mode === 'stored' && status.reason !== 'upgrading'
})

/** A run from any way in: its read, its dialogs and its removals. */
export const deleteSessionsRunning = shallowRef(false)

/** Why it cannot run, in an existing line; none while storage starts. */
const unavailableLine = (): string | undefined => {
    const { safe, storage } = i18n.value
    if (isSafeMode()) return safe.bar
    const cause = causeOf(storageStatus.value)
    if (cause?.kind === 'unavailable') return storage.unavailable
    if (cause?.kind === 'readOnly') return storage.reason.readOnly
    if (cause?.kind === 'paused') return pausedReasonLine(cause.reason)
    return undefined
}

/** Delete Sessions…: the choice, the confirm, then the removal with its progress and notices. */
export const runDeleteSessions = async (): Promise<void> => {
    if (deleteSessionsRunning.value) return
    if (!canDeleteSessions.value) {
        const line = unavailableLine()
        if (line) notify(() => line)
        return
    }
    deleteSessionsRunning.value = true
    try {
        const strings = () => i18n.value.settings.localData
        const sessions = await import('../../local/deleteSessions')
        // Read first, so the dialog never shows counts it does not know.
        const read = await sessions.readDeleteChoices()
        if (read.storedRead === 'failed') {
            notify(() => i18n.value.history.sessions.loadFailed, { card: true, severity: 'error' })
            return
        }
        const targets: DeleteChain[] | undefined = await showModal(DeleteSessionsDialog, {
            chains: read.storedValue,
        })
        if (!targets?.length) return
        // Cancel is the default: a stray Enter deletes nothing.
        const confirmed = await showChoice({
            title: () => strings().deleteTitle,
            lines: () => {
                const { history, modals } = i18n.value
                return confirmLines(targets, (chain) => shownName(chain.name), {
                    confirm: strings().deleteConfirm,
                    notSaved: strings().notSaved,
                    namesMore: strings().namesMore,
                    newer: strings().newer,
                    listJoin: modals.form.listJoin,
                    quoted: history.quoted,
                })
            },
            choices: [{ value: true, label: () => i18n.value.modals.confirm.delete, danger: true }],
            cancelIsDefault: true,
        })
        if (!confirmed) return
        // A peek of a chain about to go ends first, as a row's Delete ends it before the mark.
        const peeked = peekedSession.value?.chainId
        if (peeked !== undefined && targets.some((chain) => chain.chainId === peeked)) backToNow()
        const abort = new AbortController()
        const outcome = sessions
            .deleteSessions(targets, undefined, abort.signal)
            .catch((error: unknown) => {
                console.error(error)
                return { kind: 'failed' as const, deleted: 0 }
            })
        // Closing the dialog stops the run between chains; each chain's removal is whole.
        await showModal(LoadingModal, {
            title: () => strings().deleteTitle,
            async *task(signal: AbortSignal) {
                const cancel = () => {
                    abort.abort()
                }
                signal.addEventListener('abort', cancel, { once: true })
                yield () => strings().deleting
                try {
                    await outcome
                } finally {
                    signal.removeEventListener('abort', cancel)
                }
            },
        })
        const result = await outcome
        // A card, not a quick toast that fades over the open dialog. What was asked for and did not
        // go is never silent; closing the dialog asked to stop.
        const notDeleted = abort.signal.aborted ? 0 : targets.length - result.deleted
        const done =
            result.deleted > 0
                ? interpolate(() => i18n.value.session.deletedMany, String(result.deleted))
                : undefined
        const failed =
            notDeleted > 0 ? interpolate(() => strings().notDeleted, String(notDeleted)) : undefined
        if (done && failed)
            notify(() => done() + '\n' + failed(), {
                lines: [{ message: done }, { message: failed, severity: 'error' }],
            })
        else if (done) notify(done, { card: true })
        else if (failed) notify(failed, { card: true, severity: 'error' })
        // The user's own act, so Recent Sessions reads at once, whatever holds its rows.
        if (result.deleted > 0) deleteChanged()
    } finally {
        deleteSessionsRunning.value = false
    }
}
