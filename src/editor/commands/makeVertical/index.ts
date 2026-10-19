import type { Command } from '..'
import { pushState, state } from '../../../history'
import { createHistoryOperation } from '../../../history/createHistoryOperation'
import { i18n } from '../../../i18n'
import { makeVerticalWithReceipt as applyMakeVertical } from '../../../state/operations/makeVertical'
import { notify } from '../../notification'
import { view } from '../../view'
import MakeVerticalIcon from './MakeVerticalIcon.vue'

export const makeVertical: Command = {
    title: () => i18n.value.commands.makeVertical.title,
    icon: { is: MakeVerticalIcon },
    execute() {
        const source = state.value
        const notes = new Set(source.selectedEntities.filter((entity) => entity.type === 'note'))
        if (!notes.size) {
            notify(() => i18n.value.commands.makeVertical.noSelected)
            return
        }
        const { state: result, counts } = applyMakeVertical(source, source.selectedEntities)
        if (result === source) {
            const beat = [...notes][0]?.beat
            const unchanged = [...notes].every((note) => note.beat === beat)
            notify(() =>
                unchanged
                    ? i18n.value.commands.makeVertical.unchanged
                    : i18n.value.commands.makeVertical.invalid,
            )
            return
        }
        const operation = createHistoryOperation({
            id: 'nse.note.vertical',
            data: { targets: counts.note ?? 0 },
        })
        pushState(operation, result)
        view.entities = { hovered: [], creating: [] }
        notify(() => operation.fallback.text)
    },
}
