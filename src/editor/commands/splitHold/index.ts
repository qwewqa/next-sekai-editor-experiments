import type { Command } from '..'
import { pushState, state } from '../../../history'
import { createHistoryOperation } from '../../../history/createHistoryOperation'
import { i18n } from '../../../i18n'
import { getSplitHoldNotes, splitHold as split } from '../../../state/operations/splitHold'
import { notify } from '../../notification'
import { view } from '../../view'
import SplitHoldIcon from './SplitHoldIcon.vue'

export const splitHold: Command = {
    title: () => i18n.value.commands.splitHold.title,
    icon: { is: SplitHoldIcon },
    execute() {
        const source = state.value
        const count = getSplitHoldNotes(source, source.selectedEntities).length
        if (!count) {
            notify(() => i18n.value.commands.splitHold.noConnections)
            return
        }
        const operation = createHistoryOperation({ id: 'nse.note.split', data: { targets: count } })
        pushState(operation, split(source, source.selectedEntities))
        view.entities = { hovered: [], creating: [] }
        notify(() => operation.fallback.text)
    },
}
