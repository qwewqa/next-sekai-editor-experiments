// Opens Export Video for the chart on screen, peeks included.

import { isPeeking, state } from '../../history'
import { playbackBgm } from '../../history/bgm'
import { session } from '../../history/session'
import { displayName, namePartsOf, prefillOf } from '../../local/names'
import { showModal } from '../../modals'
import { parseColor } from '../../rendering/paint'
import { settings } from '../../settings'
import { validName } from '../commands/exportLevel/fileName'
import { peekedInfo, peekedSession } from '../history/selection'
import { waitForCurrentBgm } from '../media/heldBgm'
import { stopPlayer } from '../player'
import { view } from '../view'
import type { createExportDialog, DialogInput } from './dialog'
import type { ExportVideoEnv } from './env'
import ExportVideoModal from './ExportVideoModal.vue'
import { takeStoppedExports } from './recovery'

/** The shown session's name as a file name stem, or empty for `Video`. */
const shownStem = () => {
    const open = session.value
    const parts = namePartsOf(
        {
            name: open.name,
            sourceName: open.sourceName,
            ...(open.file ? { file: { name: open.file.name } } : {}),
        },
        state.value,
    )
    return validName(prefillOf(displayName(parts)))
}

/** The preview's backdrop colour, as the preview reads it for the current theme. */
const backdrop = (): DialogInput['look']['backdrop'] => {
    const channels = getComputedStyle(document.documentElement).getPropertyValue('--color-preview')
    const [r, g, b] = parseColor(`rgb(${channels.trim()})`)
    return [r, g, b]
}

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
        const [loaded] = await Promise.all([waitForCurrentBgm(bgmWaitMs), takeStoppedExports()])
        if (session.value.sessionId !== origin) return
        const snapshot = state.value
        const bgm = loaded
            ? playbackBgm.value
            : { ...playbackBgm.value, buffer: undefined, waveform: undefined }
        const input: DialogInput = {
            snapshot,
            source: isPeeking.value ? 'peek' : 'live',
            chain: session.value.docId,
            cursor: view.cursorTime,
            stem: shownStem(),
            look: {
                aspect: settings.previewAspectRatio,
                noteSpeed: settings.previewNoteSpeed,
                showEffects: settings.previewShowEffects,
                showCombo: settings.previewShowCombo,
                backdrop: backdrop(),
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
