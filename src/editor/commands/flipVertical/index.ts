import type { Command } from '..'
import { pushState, state } from '../../../history'
import { createHistoryOperation } from '../../../history/createHistoryOperation'
import { i18n } from '../../../i18n'
import { flipVerticalWithReceipt as flip } from '../../../state/operations/flipVertical'
import { changedData } from '../../../state/operations/historyReceipts'
import { notify } from '../../notification'
import { toMovedBeat, view } from '../../view'
import FlipIcon from '../flip/FlipIcon.vue'

export const flipVertical: Command = {
    title: () => i18n.value.commands.flipVertical.title,
    icon: { is: FlipIcon, props: { class: 'rotate-90' } },
    execute() {
        const source = state.value
        if (!source.selectedEntities.length) {
            notify(() => i18n.value.commands.flip.noSelected)
            return
        }
        // Flipped beats land on the grid without float noise, as moves do.
        const {
            state: flipped,
            counts,
            displaced,
            retainedInitialBpm,
        } = flip(source, source.selectedEntities, toMovedBeat)
        if (flipped === source) {
            notify(() => i18n.value.sidebars.default.noChange)
            return
        }
        const operation = createHistoryOperation({
            id: 'nse.object.flip',
            data: {
                axis: 'vertical',
                ...changedData(counts, 'objects', { displaced, retainedInitialBpm }),
            },
        })
        const pushed = pushState(operation, flipped)
        view.entities = { hovered: [], creating: [] }
        if (pushed) notify(() => operation.fallback.text)
    },
}
