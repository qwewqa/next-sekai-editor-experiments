// The editor's colours (src/utils/colors.ts) plus the note defaults of src/editor/canvas/notes.ts,
// whose constants aren't exported (tests/builtin/palette.test.mjs keeps the copies equal).
import {
    activeColors,
    connectorStyleColor,
    damageColor,
    guideColors,
    noteStyleColors,
} from '../src/utils/colors.ts'

export { activeColors, damageColor, guideColors, noteStyleColors }

/** The style colours in the engine's order, capitalised as in sprite and effect names. */
export const colorNames = ['Neutral', 'Red', 'Green', 'Blue', 'Yellow', 'Purple', 'Cyan', 'Black']

/** [outer, inner, accent] of a style colour name. */
export const styleColors = (name) => noteStyleColors[name.toLowerCase()]

/** The colour of a style's connectors and guides (black stays visible). */
export const connectorColor = (name) => connectorStyleColor(name.toLowerCase())

/** The colour of a style's judgment pieces. */
export const guideColor = (name) => guideColors[name.toLowerCase()]

/** Note body colours: [outer, inner, accent]. */
export const bodyColors = {
    tap: ['#aabfff', '#e6edff', '#8394f6'],
    slide: ['#81f8cf', '#dafdf1', '#5ce29d'],
    flick: ['#fec3dc', '#ffedf5', '#f89cc2'],
    critical: ['#fed983', '#fffccc', '#fed84b'],
}

export const traceColors = { green: '#5fefc2', red: '#fe9ccb', yellow: '#fddd86' }
export const diamondColors = { green: '#abfbe3', red: '#ffd8f6', yellow: '#fff2c3' }
export const arrowColors = { normal: '#ec7cb4', critical: '#ffc633' }
export const damage = { color: '#a50acc', edge: '#d28ae6' }

/** The editor's stage colours (the preview navy, the stage stroke and the accent). */
export const stage = { navy: '#292b42', stroke: '#b4d6e8', accent: '#77efdc' }
