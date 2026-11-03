// Opens Export Video for the chart on screen, peeks included.

import { isPeeking, state } from '../../history'
import { playbackBgm } from '../../history/bgm'
import { session } from '../../history/session'
import { showModal } from '../../modals'
import { readPreviewBackdrop } from '../../preview/backdrop'
import { settings } from '../../settings'
import { peekedInfo, peekedSession } from '../history/selection'
import { waitForCurrentBgm } from '../media/heldBgm'
import { stopPlayer } from '../player'
import { view } from '../view'
import type { createExportDialog, DialogInput } from './dialog'
import type { ExportVideoEnv } from './env'
import ExportVideoModal from './ExportVideoModal.vue'
import { takeStoppedExports } from './recovery'
import { exportSubject } from './subject'

/** The step on screen, as the History peek bar names it: a session by its name. */
const peekStep = () => {
    const session = peekedSession.value
    if (session) return { name: session.name, time: session.time }
    const info = peekedInfo.value
    return info && { time: info.time }
}

let opening = false

export const openExportVideo = async (
    env: ExportVideoEnv,
    expose?: (dialog: ReturnType<typeof createExportDialog>) => void,
    bgmWaitMs = 10_000,
) => {
    if (opening) return
    opening = true
    const origin = session.value.sessionId
    try {
        stopPlayer()
        const [loaded] = await Promise.all([
            waitForCurrentBgm(bgmWaitMs),
            // The markers only choose the opening settings, so the dialog opens without them.
            Promise.resolve()
                .then(takeStoppedExports)
                .catch((error: unknown) => {
                    console.error(error)
                }),
        ])
        if (session.value.sessionId !== origin) return
        const snapshot = state.value
        const bgm = loaded
            ? playbackBgm.value
            : { ...playbackBgm.value, buffer: undefined, waveform: undefined }
        const { stem, chain } = exportSubject(session.value, snapshot, peekedSession.value)
        const input: DialogInput = {
            snapshot,
            source: isPeeking.value ? 'peek' : 'live',
            ...(chain === undefined ? {} : { chain }),
            cursor: view.cursorTime,
            stem,
            look: {
                aspect: settings.previewAspectRatio,
                noteSpeed: settings.previewNoteSpeed,
                showEffects: settings.previewShowEffects,
                showCombo: settings.previewShowCombo,
                backdrop: readPreviewBackdrop(),
            },
            bgm,
            bgmMissing: bgm.buffer ? undefined : bgm.meta ? 'notLoaded' : 'none',
            selection: [...snapshot.selectedEntities],
            env,
        }
        await showModal(
            ExportVideoModal,
            {
                input,
                peekStep: input.source === 'peek' ? peekStep() : undefined,
                expose,
            },
            { size: 'large', wide: true },
        )
    } finally {
        opening = false
    }
}
