import type { Command } from '..'
import { i18n } from '../../../i18n'
import { showModal } from '../../../modals'
import StatisticsModal from '../../statistics/StatisticsModal.vue'
import StatisticsIcon from './StatisticsIcon.vue'

// Statistics: a read-only dialog about the chart on screen, peeks included.
export const statistics: Command = {
    title: () => i18n.value.commands.statistics.title,
    icon: {
        is: StatisticsIcon,
    },

    readOnly: true,

    async execute() {
        await showModal(StatisticsModal, {})
    },
}
