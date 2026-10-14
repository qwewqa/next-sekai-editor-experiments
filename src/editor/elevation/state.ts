import { ref, watch } from 'vue'
import { bpms } from '../../history/bpms'
import { selectedEntities } from '../../history/selectedEntities'
import { beatToTime, timeToBeat } from '../../state/integrals/bpms'
import { nearGridBeat } from '../../state/integrals/grid'
import { committedGrid } from '../beatGrid'
import { editorNavigation } from '../navigation'
import { switchToolTo, type ToolName } from '../tools'
import { toolName } from '../tools/state'
import { view } from '../view'

export const elevationBeat = ref(0)
export const isElevationEditorOpen = ref(false)
export const isElevationSideBySide = ref(false)

export const elevationToolNames: readonly ToolName[] = [
    'select',
    'note',
    'slide',
    'eraser',
    'brush',
    'paste',
    'generateSlideNotes',
]

export const openElevationEditor = (beat?: number) => {
    if (isElevationEditorOpen.value && beat === undefined) return

    const wasOpen = isElevationEditorOpen.value
    const note = selectedEntities.value.filter((entity) => entity.type === 'note').pop()
    const displayedBeat =
        beat ??
        note?.beat ??
        nearGridBeat(
            committedGrid.value,
            timeToBeat(bpms.value, Math.max(0, view.cursorTime)),
            view.division,
        )
    isElevationEditorOpen.value = true
    view.cursorTime = beatToTime(bpms.value, displayedBeat)
    elevationBeat.value = displayedBeat
    // It keeps a tool it has, else opens on Select; already open, it only changes beat.
    if (!wasOpen)
        switchToolTo(elevationToolNames.includes(toolName.value) ? toolName.value : 'select')
}

export const closeElevationEditor = () => {
    isElevationEditorOpen.value = false
}

// Full screen, it closes on a tool it lacks, whether the tool or the layout changes.
watch(
    [toolName, isElevationSideBySide],
    ([name, sideBySide]) => {
        if (isElevationEditorOpen.value && !sideBySide && !elevationToolNames.includes(name))
            isElevationEditorOpen.value = false
    },
    { flush: 'sync' },
)

watch(
    () => view.cursorTime,
    (time) => {
        if (isElevationEditorOpen.value)
            elevationBeat.value = nearGridBeat(
                committedGrid.value,
                timeToBeat(bpms.value, Math.max(0, time)),
                view.division,
            )
    },
    { flush: 'sync' },
)

let stopFollowingSelection: (() => void) | undefined

watch(
    isElevationEditorOpen,
    (open) => {
        stopFollowingSelection?.()
        stopFollowingSelection = undefined
        if (!open) return
        stopFollowingSelection = watch(
            selectedEntities,
            (selection, previousSelection) => {
                if (!isElevationSideBySide.value || editorNavigation.value) return
                const notes = selection.filter((entity) => entity.type === 'note')
                const note = notes[0]
                if (
                    !note ||
                    notes.some((other) => other.beat !== note.beat) ||
                    !notes.some((other) => !previousSelection.includes(other))
                )
                    return
                view.cursorTime = beatToTime(bpms.value, note.beat)
                elevationBeat.value = note.beat
            },
            { flush: 'sync' },
        )
    },
    { flush: 'sync' },
)
