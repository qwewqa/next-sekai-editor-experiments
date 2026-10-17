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
export const stage = { navy: '#292b42', lane: '#1c1e31', stroke: '#b4d6e8', accent: '#77efdc' }

const channels = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16))

/** The colour t of the way from a to b, as #rrggbb. */
export const mix = (a, b, t) =>
    '#' +
    channels(a)
        .map((value, i) => Math.round(value + (channels(b)[i] - value) * t))
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('')

/** A colour pushed to full saturation at a lightness of at most 0.62, for effects on the dark stage. */
export function vivid(hex) {
    const [r, g, b] = channels(hex).map((value) => value / 255)
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    if (max === min) return hex
    const d = max - min
    const hue =
        (max === r
            ? (g - b) / d + (g < b ? 6 : 0)
            : max === g
              ? (b - r) / d + 2
              : (r - g) / d + 4) / 6
    const l = Math.min((max + min) / 2, 0.62)
    const q = l < 0.5 ? l * 2 : l + 1 - l
    const p = 2 * l - q
    const channel = (t) => {
        t = (t + 1) % 1
        const value =
            t < 1 / 6
                ? p + (q - p) * 6 * t
                : t < 1 / 2
                  ? q
                  : t < 2 / 3
                    ? p + (q - p) * (2 / 3 - t) * 6
                    : p
        return Math.round(value * 255)
            .toString(16)
            .padStart(2, '0')
    }
    return `#${channel(hue + 1 / 3)}${channel(hue)}${channel(hue - 1 / 3)}`
}
