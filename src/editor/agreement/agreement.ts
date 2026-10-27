import { shallowRef } from 'vue'
import { holdArming } from '../../analytics/tally'
import { LEGAL_PAGES } from '../../buildInfo'
import { recordError } from '../../diagnostics'
import { closeModal, modals, showModal, type Modal } from '../../modals'
import { startupEnded, startupGate } from '../../startup/gate'
import { storageGet, storageKey, storageSet } from '../../storage'
import { holdStartupWindow } from '../notification'
import AgreementDialog from './AgreementDialog.vue'
import { AGREEMENT_KEY, agreed, asked, changeOf, isDue, recordOf } from './rules'

// The agreement dialog: the Terms of Service and the Privacy Notice, agreed to before the editor is
// used. App.vue imports this module last, and index.ts imports App.vue before it starts the usage
// statistics, so on a load where agreement is due no input arms the visit before Agree.

const current = asked(LEGAL_PAGES)
const read = () => recordOf(storageGet(AGREEMENT_KEY, undefined))
const due = isDue(current, read())

/** How far this load's agreement has got: the specs' ready helpers wait for `notDue` or `done`. */
export const agreementState = shallowRef<'notDue' | 'pending' | 'open' | 'done'>(
    due ? 'pending' : 'notDue',
)

if (due) holdArming(true)

// One detached task, never awaited here, so index.ts goes on to mount the app and start storage.
if (due && current)
    void (async () => {
        let windowHeld = false
        let gate: Modal | undefined
        // Another tab's Agree that covers this build closes the dialog here too.
        const onStorage = (event: StorageEvent) => {
            if (event.key === storageKey(AGREEMENT_KEY) && gate && !isDue(current, read()))
                closeModal(gate, 'elsewhere' as never)
        }
        try {
            await startupEnded()
            // The error screen shows without it; arming stays held.
            if (startupGate.phase !== 'done') return
            const record = read()
            if (!isDue(current, record)) {
                holdArming(false)
                return
            }
            agreementState.value = 'open'
            holdStartupWindow(true)
            windowHeld = true
            addEventListener('storage', onStorage)
            const pending = showModal(
                AgreementDialog,
                { change: changeOf(current, record) },
                { persistent: true },
            )
            gate = modals.at(-1)
            const result = (await pending) as 'agree' | 'elsewhere' | undefined
            if (result === 'agree')
                try {
                    storageSet(AGREEMENT_KEY, agreed(current, read()))
                } catch {
                    // Not kept: the next load asks again.
                }
            if (result === 'agree' || result === 'elsewhere') holdArming(false)
        } catch (error) {
            // The editor stays usable; nothing is stored or sent.
            recordError(error)
        } finally {
            removeEventListener('storage', onStorage)
            if (windowHeld) holdStartupWindow(false)
            agreementState.value = 'done'
        }
    })()
