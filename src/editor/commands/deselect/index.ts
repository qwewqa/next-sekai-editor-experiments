import type { Command } from '..'
import { replaceState, state } from '../../../history'
import { selectedEntities } from '../../../history/selectedEntities'
import { i18n } from '../../../i18n'
import { settings } from '../../../settings'
import { notify } from '../../notification'
import { switchToolTo, toolName } from '../../tools'
import { view } from '../../view'
import DeselectIcon from './DeselectIcon.vue'

export const deselect: Command = {
    title: () => i18n.value.commands.deselect.title,
    icon: {
        is: DeselectIcon,
    },

    execute() {
        // Dismisses an entity marker even with nothing selected; a cursor marker stays.
        if (view.touchMarker?.kind === 'entity') view.touchMarker = undefined

        if (!selectedEntities.value.length) {
            // A second Deselect leaves the current tool for the Select tool.
            if (
                settings.deselectSwitchesToSelect &&
                toolName.value !== 'select' &&
                toolName.value !== 'elevation'
            ) {
                switchToolTo('select')
                notify(() => i18n.value.commands.select.switched)
            }
            return
        }

        replaceState({
            ...state.value,
            selectedEntities: [],
        })
        view.entities = {
            hovered: [],
            creating: [],
        }

        notify(() => i18n.value.commands.deselect.deselected)
    },
}
