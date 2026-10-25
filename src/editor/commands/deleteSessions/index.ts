import type { Command } from '..'
import { i18n } from '../../../i18n'
import { runDeleteSessions } from '../../settings/deleteSessionsFlow'
import DeleteSessionsIcon from './DeleteSessionsIcon.vue'

/** Delete Sessions…: Settings › Local Data's flow. It leaves the chart alone, so it runs while peeking. */
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
