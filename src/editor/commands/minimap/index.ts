import type { Command } from '..'
import { i18n } from '../../../i18n'
import { toggleMinimap } from '../../minimap/state'
import MinimapIcon from './MinimapIcon.vue'

/** Shows or hides the minimap (Part 1 §1.4.22). No on state; never takes the navigation group's face. */
export const minimap: Command = {
    title: () => i18n.value.commands.minimap.title,
    icon: {
        is: MinimapIcon,
    },

    readOnly: true,
    keepsFace: true,

    execute: toggleMinimap,
}
