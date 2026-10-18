import type { Command } from '..'
import { i18n } from '../../../i18n'
import { openSettings } from '../../settings/openSettings'
import SettingsIcon from './SettingsIcon.vue'

export const settings: Command = {
    title: () => i18n.value.commands.settings.title,
    icon: {
        is: SettingsIcon,
    },

    readOnly: true,

    execute() {
        void openSettings()
    },
}
