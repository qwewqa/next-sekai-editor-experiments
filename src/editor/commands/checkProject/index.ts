import { shallowRef } from 'vue'
import type { Command } from '..'
import { busy, record } from '../../../analytics/tally'
import { i18n } from '../../../i18n'
import { showModal } from '../../../modals'
import InfoModal from '../../../modals/InfoModal.vue'
import LoadingModal from '../../../modals/LoadingModal.vue'
import { displayedName } from '../../labelText'
import { notify } from '../../notification'
import { environment } from '../../save/binding'
import CheckProjectIcon from './CheckProjectIcon.vue'

// Check File and History…: reads the bound file in full and the history stored in
// this browser, repairs what the file can repair, and tells what is left in a few lines. It is
// reachable from the command list and Level Info's file line; there is no default key.

export const checkProject: Command = {
    title: () => i18n.value.check.command,
    icon: {
        is: CheckProjectIcon,
    },

    // It changes no chart state, so it runs while peeking.
    readOnly: true,

    async execute() {
        const env = environment()
        if (!env) {
            notify(() => i18n.value.notice.storageUnavailable, { card: true, severity: 'error' })
            return
        }
        const { firstMessage, planCheck, startCheck } = await import('../../check/run')
        // Decided on the press: read access to the bound file is asked for here.
        const plan = await planCheck(env, displayedName.value)
        if (!plan) {
            await showModal(InfoModal, {
                title: () => i18n.value.check.title,
                message: () => i18n.value.notice.storageUnavailable,
            })
            return
        }
        const abort = new AbortController()
        const message = shallowRef(firstMessage(plan))
        const percent = shallowRef<number>()
        // From here, once the read access has been asked for, the check is the editor’s own work.
        const began = performance.now()
        busy(true)
        const outcome = startCheck(plan, abort.signal, (next, done) => {
            message.value = next
            percent.value = done
        })
        // The progress dialog opens at once. Its bar slides while the check waits behind a Save and
        // during the finish, and shows the fraction between a phase's first and last batch. Closing
        // it cancels the run until its finish starts.
        await showModal(LoadingModal, {
            title: () => i18n.value.check.title,
            progress: () => percent.value,
            async *task(signal: AbortSignal) {
                const cancel = () => {
                    abort.abort()
                }
                signal.addEventListener('abort', cancel, { once: true })
                yield () => message.value()
                try {
                    await outcome
                } finally {
                    signal.removeEventListener('abort', cancel)
                }
            },
        })
        const result = await outcome
        busy(false)
        if (result.kind !== 'cancelled')
            record(
                'check',
                {
                    outcome:
                        result.kind === 'failed' ? 'failed' : result.problems ? 'problems' : 'ok',
                },
                began,
            )
        if (result.kind === 'cancelled') return
        const lines = result.kind === 'failed' ? [result.message] : result.lines
        await showModal(InfoModal, {
            title: () => i18n.value.check.title,
            message: () => lines.map((line) => line()).join('\n'),
            lines,
        })
    },
}
