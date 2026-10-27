import { shallowRef, watch } from 'vue'
import { analyticsTarget } from '../../analytics/start'
import { holdArming } from '../../analytics/tally'
import { HAS_PRIVACY_PAGE } from '../../buildInfo'
import { recordError } from '../../diagnostics'
import { closeModal, isBlockingModalOpen, modals, showModal } from '../../modals'
import { isSafeMode } from '../../safe'
import { startupEnded, startupGate } from '../../startup/gate'
import { storageGet, storageSet } from '../../storage'
import { holdStartupWindow, loadNotices } from '../notification'
import FirstVisitDialog from './FirstVisitDialog.vue'
import { blocking, FIRST_VISIT_KEY, FIRST_VISIT_REVISION, firstVisitDue, isDue } from './rules'

// The first-visit dialog: the version, a few settings and the usage statistics switch with the
// privacy link, shown once per browser at the first load that can show it (rules.ts). App.vue
// imports this module, and index.ts imports App.vue before it starts the usage statistics, so on a
// load where the dialog is due no input arms the visit until the dialog is skipped or closed.

type FirstVisitState = 'notDue' | 'pending' | 'waiting' | 'open' | 'done'

const readMark = () => storageGet(FIRST_VISIT_KEY, undefined)

const dueFacts = () => ({
    offered: HAS_PRIVACY_PAGE || analyticsTarget !== null,
    safeMode: isSafeMode(),
    stored: readMark(),
})

const due = isDue(dueFacts())

/** Where this load's decision is: the specs' ready helpers wait for `notDue` or `done`. */
export const firstVisitState = shallowRef<FirstVisitState>(due ? 'pending' : 'notDue')

if (due) holdArming(true)

const blockingNow = () => blocking(loadNotices.value.map((notice) => notice.order))

const keep = () => {
    try {
        storageSet(FIRST_VISIT_KEY, FIRST_VISIT_REVISION)
    } catch {
        return false
    }
    return readMark() === FIRST_VISIT_REVISION
}

const decide = () =>
    firstVisitDue({
        ...dueFacts(),
        phase: startupGate.phase,
        blocking: blockingNow(),
        modalOpen: isBlockingModalOpen.value,
        visible: document.visibilityState === 'visible',
        keep,
    })

// Resolves at the first change of the page to visible.
const visible = () =>
    new Promise<void>((resolve) => {
        const onChange = () => {
            if (document.visibilityState !== 'visible') return
            document.removeEventListener('visibilitychange', onChange)
            resolve()
        }
        document.addEventListener('visibilitychange', onChange)
    })

// One detached task, never awaited here, so index.ts goes on to mount the app and start storage.
// Whatever it holds is let go in `finally`.
if (due)
    void (async () => {
        let stopWatching: (() => void) | undefined
        let windowHeld = false
        try {
            await startupEnded()
            let decision = decide()
            if (decision === 'waitVisible') {
                firstVisitState.value = 'waiting'
                await visible()
                decision = decide()
            }
            if (decision !== 'show') return
            firstVisitState.value = 'open'
            holdStartupWindow(true)
            windowHeld = true
            // A late load notice that is not allowed under the dialog closes it, and the card shows.
            stopWatching = watch(loadNotices, () => {
                const dialog = modals.find((modal) => modal.is === FirstVisitDialog)
                if (dialog && blockingNow()) closeModal(dialog)
            })
            await showModal(FirstVisitDialog, {})
        } catch (error) {
            recordError(error)
        } finally {
            stopWatching?.()
            if (windowHeld) holdStartupWindow(false)
            firstVisitState.value = 'done'
            holdArming(false)
        }
    })()
