import type { Command } from '..'
import { isPeeking, liveState, pushState } from '../../../history'
import { bgm as currentBgm } from '../../../history/live'
import { refuseWhilePeeking } from '../../../history/peek'
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
    // Choose Audio… (a load notice's) is an edit: refused while peeking (§1.4.11).
    if (isPeeking.value) {
        refuseWhilePeeking()
        return
    }
    const newBgm = await showModal(BgmModal, {
        bgm: currentBgm.value,
        file,
    })
    // A peek begun meanwhile closed the dialog.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!newBgm || isPeeking.value) return
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
