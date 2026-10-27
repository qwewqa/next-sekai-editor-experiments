import { isPeeking, liveState } from '../../../history'
import { refuseWhilePeeking } from '../../../history/peek'
import { session } from '../../../history/session'
import { stackGeneration } from '../../../history/stack'
import { i18n } from '../../../i18n'
import { showModal } from '../../../modals'
import LoadingModal from '../../../modals/LoadingModal.vue'
import { BGM_MAX_MINUTES } from '../../../utils/bgmLimit'
import { pickFile } from '../../../utils/file'
import { interpolate } from '../../../utils/interpolate'
import { releaseWaveform } from '../../../waveform'
import { bgmOperation } from '../../headerLabels'
import { LOAD_ORDER } from '../../loadOrder'
import { applyPick, type PickedBgm } from '../../media/applyPick'
import {
    bgmStatus,
    claimNotice,
    onBgmRefused,
    onRefusalLine,
    onUnheldAfterMove,
    type BgmRefusal,
} from '../../media/heldBgm'
import {
    addLoadNotice,
    dropCardAction,
    notify,
    startupNoticeCurrent,
    type NoticeAction,
    type NoticeLine,
} from '../../notification'
import { loadPickedBgm } from './loadPicked'

// Choose Audio…: the action of every "BGM not loaded" line.
// It opens the system chooser at once, with no dialog and no change of the offset; `applyPick`
// decides what the file is for.

/** Picks an audio file for the live state's BGM. */
export const chooseAudio = async () => {
    // An edit: refused while peeking.
    if (isPeeking.value) {
        refuseWhilePeeking()
        return
    }
    const id = session.value.sessionId
    const generation = stackGeneration()
    const file = await pickFile()
    if (!file) return
    // What the pick is for no longer holds when the session, the stack or the screen moved on.
    const current = () =>
        session.value.sessionId === id && stackGeneration() === generation && !isPeeking.value

    const result: { picked?: PickedBgm } = {}
    await showModal(LoadingModal, {
        title: () => i18n.value.commands.bgm.title,
        async *task(signal: AbortSignal) {
            result.picked = yield* loadPickedBgm(file, () => signal.aborted, signal)
        },
    })
    const { picked } = result
    if (!picked) return
    if (!current()) {
        releaseWaveform(picked.waveform)
        return
    }
    const outcome = applyPick(picked, id, bgmOperation)
    // The audio is back: the line that offered it is not true any more.
    if (outcome.kind === 'attached') dropCardAction(chooseAudioAction)
    if (outcome.kind !== 'changed') return
    const { decision } = outcome
    // A file for audio the state named and lacked says that it is another file.
    if (decision.named)
        notify(
            decision.original === undefined
                ? () => i18n.value.notice.bgmDiffersUnnamed
                : interpolate(() => i18n.value.notice.bgmDiffers, decision.original),
            { card: true, severity: 'info' },
        )
    else notify(() => outcome.text)
}

export const chooseAudioAction: NoticeAction = {
    label: () => i18n.value.notice.chooseAudio,
    run: () => {
        void chooseAudio()
    },
}

/** The not-loaded line, as a row of a card or a card of its own. */
const unheldLine = (): NoticeLine => ({
    message: () => i18n.value.load.bgmNotLoaded,
    severity: 'info',
    action: chooseAudioAction,
})

/**
 * The second line of a switch's card (Restore Session, Reopen, Restore as a Copy), when the BGM of
 * the session just shown is not loaded and this has not been said for its hash in this session.
 * It waits for the media store's answer; a store that cannot be asked gives no line.
 */
export const takeBgmLine = async (): Promise<NoticeLine | undefined> => {
    const live = liveState.value.bgm
    const meta = live.meta
    if (!meta || live.buffer || isPeeking.value) return
    if ((await bgmStatus(meta.hash, meta.size)) !== 'absent') return
    // The session may have changed while the store was asked.
    if (liveState.value.bgm.meta?.hash !== meta.hash || !claimNotice(meta.hash)) return
    return unheldLine()
}

// Undo or Redo reached audio nothing holds: a card of its own, beside the quick "Undid…" notice.
onUnheldAfterMove(() => {
    notify(() => i18n.value.load.bgmNotLoaded, {
        card: true,
        severity: 'info',
        action: chooseAudioAction,
    })
})

/** The line for a BGM refused for its length: its text, with Choose Audio. */
export const refusalLine = (kind: BgmRefusal): NoticeLine => ({
    message: interpolate(
        () =>
            kind === 'audioTooLong'
                ? i18n.value.notice.bgmTooLong
                : i18n.value.notice.bgmMayBeTooLong,
        BGM_MAX_MINUTES,
    ),
    severity: 'info',
    action: chooseAudioAction,
})

onRefusalLine(refusalLine)

// A BGM refused for its length, at a load, a switch or Undo and Redo: a card with Choose Audio.
onBgmRefused((_hash, kind, startup) => {
    const { message, severity, action } = refusalLine(kind)
    // At load, a line of the start-up card while that shows, or only kept once it has not (a
    // reattachment that began at startup can finish after an edit); else a card of its own.
    if (startup || startupNoticeCurrent()) {
        addLoadNotice(message, action, LOAD_ORDER.bgmNotLoaded, severity)
        return
    }
    notify(message, {
        card: true,
        ...(severity ? { severity } : {}),
        ...(action ? { action } : {}),
    })
})
