import type { ToolName } from '../tools'
import type { HelpEntryId } from './content'

// Typed, so a new tool fails the type check until Help has an entry for it.
const toolEntries = {
    select: 'select',
    eraser: 'eraser',
    brush: 'brush',
    paste: 'paste',
    note: 'note',
    slide: 'slide',
    generateSlideNotes: 'generateSlideNotes',
    bpm: 'bpm',
    timeScale: 'timeScale',
    cameraEvent: 'events',
    stageMaskEvent: 'events',
    stagePivotEvent: 'events',
    stageStyleEvent: 'events',
    stageTransformEvent: 'events',
    offset: 'offset',
} as const satisfies Record<ToolName, HelpEntryId>

/**
 * The entry Help opens at. While peeking every tool is suspended for a view-only Select, so
 * History comes first. An Elevation Editor beside the chart leaves the tool in use.
 */
export const helpTargetFor = (state: {
    peeking: boolean
    elevationFull: boolean
    tool: ToolName
}): HelpEntryId =>
    state.peeking ? 'history' : state.elevationFull ? 'elevation' : toolEntries[state.tool]
