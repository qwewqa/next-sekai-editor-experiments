import type { Command } from '..'
import { i18n } from '../../../i18n'
import { runDeleteSessions } from '../../settings/deleteSessionsFlow'
import DeleteSessionsIcon from './DeleteSessionsIcon.vue'

/** Delete Sessions…, the flow in `deleteSessionsFlow.ts`. It never changes the chart, so it is allowed while a peek is open (`readOnly`). */
export const deleteSessions: Command = {
    title: () => i18n.value.settings.localData.deleteSessions,
    icon: {
        is: DeleteSessionsIcon,
    },
    readOnly: true,

    async execute() {
        await runDeleteSessions()
    },
}
