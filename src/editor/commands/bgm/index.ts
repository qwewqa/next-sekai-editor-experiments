import type { Command } from '..'
import { isPeeking, liveState, pushState } from '../../../history'
import { bgm as currentBgm } from '../../../history/live'
import { refuseWhilePeeking } from '../../../history/peek'
import { i18n } from '../../../i18n'
import { showModal } from '../../../modals'
import type { Bgm } from '../../../state/bgm'
import { releaseWaveform } from '../../../waveform'
import { createAsyncEditGuard } from '../../asyncEditGuard'
import { bgmOperation } from '../../headerLabels'
import { cacheBgm } from '../../media/heldBgm'
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
    // An edit: refused while peeking (§1.4.11).
    if (isPeeking.value) {
        refuseWhilePeeking()
        return
    }
    const guard = createAsyncEditGuard()
    const openingBgm = currentBgm.value
    try {
        const newBgm: Bgm | undefined = await showModal(BgmModal, {
            bgm: openingBgm,
            file,
        })
        // A stale prompt cannot replace later edits.
        if (!newBgm) return
        if (!guard.isCurrent()) {
            if (newBgm.waveform !== openingBgm.waveform) releaseWaveform(newBgm.waveform)
            return
        }
        // Confirming it unchanged is no edit.
        const old = currentBgm.value
        if (
            newBgm.buffer === old.buffer &&
            newBgm.offset === old.offset &&
            newBgm.filename === old.filename
        )
            return

        const operation = bgmOperation(old, newBgm)
        const pushed = pushState(operation, {
            ...liveState.value,
            bgm: newBgm,
        })

        if (pushed) {
            // Undo and Redo across this change land with its audio.
            cacheBgm(newBgm)
            notify(() => operation.fallback.text)
        }
    } finally {
        guard.dispose()
    }
}
