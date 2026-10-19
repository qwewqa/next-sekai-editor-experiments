import type { Command } from '..'
import { isPristine, redoState } from '../../../history'
import { getHistoryOperationContext } from '../../../history/createHistoryOperation'
import { describeStep } from '../../../history/operationPresentation/format'
import { i18n } from '../../../i18n'
import { interpolate } from '../../../utils/interpolate'
import { openHistoryAction } from '../../history/openHistory'
import { notify } from '../../notification'
import { view } from '../../view'
import RedoIcon from './RedoIcon.vue'

export const redo: Command = {
    title: () => i18n.value.commands.redo.title,
    icon: {
        is: RedoIcon,
    },

    leavesPeek: true,

    execute() {
        const step = redoState()
        if (step) {
            view.entities = {
                hovered: [],
                creating: [],
            }

            notify(
                interpolate(
                    () => i18n.value.commands.redo.redid,
                    () => describeStep(step, getHistoryOperationContext()),
                ),
            )
        } else {
            notify(() => i18n.value.commands.redo.noState, {
                action: openHistoryAction(isPristine.value ? 'sessions' : 'timeline'),
            })
        }
    },
}
