import { watch } from 'vue'
import { onPeekLeft, onPeekRefused, onPeekStart, setPeekEffects } from '../history/peek'
import { onResetState } from '../history/resetHooks'
import { isPeeking } from '../history/stack'
import { i18n } from '../i18n'
import { formatClockSeconds } from '../i18n/dateTime'
import { clearPreviewEdit, previewEdit } from '../preview/edit'
import { settings } from '../settings'
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
import { notify } from './notification'
import { view } from './view'

// The editor's side of peek (Part 1 §1.4.11): the refusal and Restore notices, cancelling
// drags and scaling sessions on entering, and the Elevation Editor closed while peeking unless
// side by side, then reopened on leaving.

const clock = (time: number) => () => formatClockSeconds(settings.locale, time)

setPeekEffects({
    restoredLabel: (time) => interpolate(() => i18n.value.entry.restoredTo, clock(time)),
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

// A new chart or stack (New, Open, a reload's) ends the peek with nothing to reopen.
onResetState(() => {
    reopenAt = undefined
})
