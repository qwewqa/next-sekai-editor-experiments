import type { Command } from '..'
import { isPeeking, state } from '../../../history'
import { stackGeneration } from '../../../history/stack'
import { i18n } from '../../../i18n'
import { showModal } from '../../../modals'
import { applyLevelInfo } from '../../levelInfo/apply'
import { draftOf } from '../../levelInfo/draft'
import LevelInfoIcon from './LevelInfoIcon.vue'
import LevelInfoModal from './LevelInfoModal.vue'

// Level Info (Part 1 §1.4.12): the status label's dialog. The command id stays `properties`, which
// v0.5.22's toolbar and shortcut settings store.
export const levelInfo: Command = {
    title: () => i18n.value.commands.properties.title,
    icon: {
        is: LevelInfoIcon,
    },

    // Level Info opens read-only while peeking (§1.4.11).
    readOnly: true,

    async execute() {
        const generation = stackGeneration()
        const opening = draftOf(state.value.levelInfo, state.value.initialLife)
        const draft = await showModal(LevelInfoModal, { opening, readOnly: isPeeking.value })
        // Nothing is changed while peeking; Apply refuses if a peek began or the session changed.
        if (!draft || isPeeking.value) return
        applyLevelInfo(opening, draft, generation)
    },
}
