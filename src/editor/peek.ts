import { watch } from 'vue'
import { bpms } from '../history/bpms'
import { createHistoryOperation } from '../history/createHistoryOperation'
import { onPeekLeft, onPeekRefused, onPeekStart, setPeekEffects } from '../history/peek'
import { onResetState } from '../history/resetHooks'
import { isPeeking } from '../history/stack'
import { i18n } from '../i18n'
import { clearPreviewEdit, previewEdit } from '../preview/edit'
import { settings } from '../settings'
import { beatToTime, isSameTempo, timeToBeat } from '../state/integrals/bpms'
import { interpolate } from '../utils/interpolate'
import { cancelScalingSession, scalingSession } from './commands/scaleSelection/session'
import { cancelMouseControls } from './controls/mouse'
import { cancelTouchControls } from './controls/touch'
import {
    closeElevationEditor,
    elevationBeat,
    isElevationEditorOpen,
    isElevationSideBySide,
    openElevationEditor,
} from './elevation/state'
import { historyCalendar } from './history/calendarClock'
import { historyFormat } from './history/historyFormat'
import { notify } from './notification'
import { view } from './view'

// The editor's side of peek: the refusal and Restore notices, cancelling
// drags and scaling sessions on entering, and the Elevation Editor closed while peeking unless
// side by side, then reopened on leaving.

// The notice names the time in the History clock and zone of the moment the step was restored; the
// locale stays live.
const clock = (time: number) => {
    const calendar = historyCalendar()
    return () => historyFormat(calendar, settings.locale).entryTime(time)
}

setPeekEffects({
    restoredOperation: (time) =>
        createHistoryOperation({ id: 'nse.restore', data: { targetTime: time } }),
    restored: (time) => {
        notify(interpolate(() => i18n.value.notice.restoredTo, clock(time)))
    },
    alreadyMatches: () => {
        notify(() => i18n.value.notice.alreadyMatches)
    },
})

onPeekRefused(() => {
    notify(() => i18n.value.notice.readOnlyPeek)
})

/** The beat the Elevation Editor showed when a peek closed it; reopened on leaving. */
let reopenAt: number | undefined

/** History's View Chart defers the fullscreen editor until this peek ends. */
export const restoreElevationAfterPeek = (beat: number) => {
    if (isPeeking.value) reopenAt ??= beat
    else openElevationEditor(beat)
}

const closeElevationForPeek = () => {
    if (!isElevationEditorOpen.value || isElevationSideBySide.value) return
    reopenAt = elevationBeat.value
    closeElevationEditor()
}

onPeekStart(() => {
    // A drag, placement or scaling session in progress would land on the peeked state.
    cancelMouseControls()
    cancelTouchControls()
    view.selection = undefined
    view.entities = { hovered: [], creating: [] }
    if (scalingSession.value) cancelScalingSession()
    // A Properties draft stays for after the peek; a tool's preview goes.
    if (!previewEdit.value?.isDraft) clearPreviewEdit()
    closeElevationForPeek()
})

// Leaving side by side while peeking closes it as well.
watch(
    isElevationSideBySide,
    () => {
        if (isPeeking.value) closeElevationForPeek()
    },
    { flush: 'sync' },
)

onPeekLeft(() => {
    if (reopenAt === undefined) return
    const beat = reopenAt
    reopenAt = undefined
    openElevationEditor(beat)
})

// Peek holds the beat: entering, moving between and leaving peeks keeps the beat at the
// pane's middle in place, so a section stays put across tempo changes between entries. Edits at
// Now keep the time, as before.
watch([bpms, isPeeking], ([next, peeking], [previous, wasPeeking]) => {
    if ((!peeking && !wasPeeking) || isSameTempo(next, previous)) return
    const hold = (time: number) => beatToTime(next, timeToBeat(previous, time))
    view.time = hold(view.time)
    view.cursorTime = hold(view.cursorTime)
    if (view.scrollingY?.type === 'ease') view.scrollingY = undefined
})

// A new chart or stack (New, Open, a reload's) ends the peek with nothing to reopen.
onResetState(() => {
    reopenAt = undefined
})
