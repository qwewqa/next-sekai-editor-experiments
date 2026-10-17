import type { Command } from '..'
import { liveState, pushState } from '../../../history'
import { bgm as currentBgm } from '../../../history/live'
import { i18n } from '../../../i18n'
import { showModal } from '../../../modals'
import { notify } from '../../notification'
import BgmIcon from './BgmIcon.vue'
import BgmModal from './BgmModal.vue'

export const bgm: Command = {
    title: () => i18n.value.commands.bgm.title,
    icon: {
        is: BgmIcon,
    },

    execute() {
        void changeBgm()
    },
}

export const changeBgm = async (file?: File) => {
    const newBgm = await showModal(BgmModal, {
        bgm: currentBgm.value,
        file,
    })
    if (!newBgm) return
    // Confirming it unchanged is no edit.
    const old = currentBgm.value
    if (
        newBgm.buffer === old.buffer &&
        newBgm.offset === old.offset &&
        newBgm.filename === old.filename
    )
        return

    pushState(() => i18n.value.commands.bgm.changed, {
        ...liveState.value,
        bgm: newBgm,
    })

    notify(() => i18n.value.commands.bgm.changed)
}
