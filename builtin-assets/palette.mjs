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

/** The lane background of each colour but Default, which is `stage.lane`; drawn at `laneAlpha`. */
export const laneColors = {
    Neutral: '#9e9e9e',
    Red: '#99415a',
    Green: '#0b7643',
    Blue: '#4160a7',
    Yellow: '#977e0d',
    Purple: '#734f99',
    Cyan: '#02717a',
    Black: '#000000',
}

/** The lane background's body alpha, which the engine's colour fades assume. */
export const laneAlpha = 0.4

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
export const damageFace = '#a50acc'

/**
 * Colours sampled from the base set (Next SEKAI 01) where ours must match it side by side: the
 * connectors (at rest and held), the slot glows, the effects, the standard ticks and markers, the
 * grids, the styled diamonds and the styled critical notes. The base's styled pieces follow its own
 * rule per style hue, so they are listed per style.
 */
export const baseColors = {
    connector: {
        normal: ['#83ffd4', '#67fff1'],
        critical: ['#fcffde', '#fff59c'],
        damage: ['#c773e5', '#e573a1'],
    },
    // Slot glows run through hues from the note (light) up the lane: [at the note, middle, top].
    slotGlow: {
        Cyan: ['#aad0ff', '#2983ff', '#6c28ff'],
        Green: ['#20ff92', '#42ffd1', '#11b6ff'],
        Red: ['#fe8dd1', '#ff59b4', '#ff188f'],
        Yellow: ['#ffb07c', '#fff273', '#bdff0b'],
        'Yellow Flick': ['#feb15e', '#ffde4c', '#d9ff27'],
        'Green Slider Hold': ['#08ff9e', '#02fff7', '#0095ff'],
        'Yellow Slider Hold': ['#a9ff53', '#5cff2e', '#00ff00'],
        'Yellow Slider Tap': ['#dbfb43', '#d3ff5e', '#86ff0b'],
    },
    // Per style, the faces of normal and critical diamonds.
    styleDiamond: {
        Neutral: ['#cdcdcd', '#dedede'],
        Red: ['#f9a1c4', '#ffbfd8'],
        Green: ['#a1f9db', '#bfffe9'],
        Blue: ['#a1a1f9', '#bfbfff'],
        Yellow: ['#f9dfa1', '#ffecbf'],
        Purple: ['#e1a1f9', '#edbfff'],
        Cyan: ['#a1f0f9', '#bff8ff'],
        Black: ['#5e5e5e', '#7a7a7a'],
    },
    // Per style, the critical notes' own colours: the body [outer, inner, accent], the trace bar,
    // the slot and the flick arrow.
    styleCritical: {
        Neutral: {
            body: ['#bfbfbf', '#e5e5e5', '#a3a3a3'],
            trace: '#c1c1c1',
            slot: '#c3c3c3',
            arrow: '#999999',
        },
        Red: {
            body: ['#fe80b3', '#ffcce0', '#fe4a92'],
            trace: '#fe85b6',
            slot: '#ff84b5',
            arrow: '#ff3385',
        },
        Green: {
            body: ['#80fed3', '#ccffee', '#4afec0'],
            trace: '#85fed5',
            slot: '#84ffd5',
            arrow: '#33ffb9',
        },
        Blue: {
            body: ['#8080fe', '#ccccff', '#4a4afe'],
            trace: '#8585fe',
            slot: '#8484ff',
            arrow: '#3333ff',
        },
        Yellow: {
            body: ['#fed980', '#fff0cc', '#fec84a'],
            trace: '#feda85',
            slot: '#ffdb84',
            arrow: '#ffc333',
        },
        Purple: {
            body: ['#dc80fe', '#f1ccff', '#cd4afe'],
            trace: '#dd85fe',
            slot: '#de84ff',
            arrow: '#c833ff',
        },
        Cyan: {
            body: ['#80f1fe', '#ccfaff', '#4aeafe'],
            trace: '#85f1fe',
            slot: '#84f2ff',
            arrow: '#33e9ff',
        },
        Black: {
            body: ['#4a4a4a', '#8c8c8c', '#3e3e3e'],
            trace: '#4b4b4b',
            slot: '#4c4c4c',
            arrow: '#3d3d3d',
        },
    },
    // Black traces: the bar in the base's grey, which reads on the lane where the editor's black
    // does not, and its light lower edge.
    blackTrace: { bar: '#3f3f3f', edge: '#5b5b5b' },
    // The grid lines' colours, which the engine's preview mode draws: NEUTRAL for beats, the
    // others for events.
    grid: {
        NEUTRAL: '#808080',
        RED: '#ff4040',
        GREEN: '#40ff40',
        BLUE: '#4040ff',
        YELLOW: '#ffff40',
        PURPLE: '#ff40ff',
        CYAN: '#40ffff',
    },
    // The halo round critical diamonds, sampled round the base's critical slide diamonds: the
    // default's and one per style.
    diamondHalo: '#c49400',
    styleDiamondHalo: {
        Neutral: '#626262',
        Red: '#c4004e',
        Green: '#00c481',
        Blue: '#0000c4',
        Yellow: '#c48a00',
        Purple: '#8f00c4',
        Cyan: '#00afc4',
        Black: '#333333',
    },
    // The face of each style's damage note in the base: a deep shade of the style's hue, much
    // darker than its trace.
    styleDamage: {
        Neutral: '#5f5f5f',
        Red: '#be004c',
        Green: '#00be7d',
        Blue: '#0000be',
        Yellow: '#be8600',
        Purple: '#8b00be',
        Cyan: '#00aabe',
    },
    // The light glow round critical bodies and traces, sampled round the base's critical bodies:
    // the default's and one per style. The base's Black glow (#3e3e3e) does not show on the stage,
    // so Black's is a light grey.
    criticalGlow: '#f8f166',
    styleCriticalGlow: {
        Neutral: '#adadad',
        Red: '#f868a0',
        Green: '#68f8c5',
        Blue: '#6868f8',
        Yellow: '#f8cc68',
        Purple: '#cd68f8',
        Cyan: '#68e7f8',
        Black: '#a8a8a8',
    },
    // Per style, the slot glows of normal and critical notes.
    styleGlow: {
        Neutral: [
            ['#d4d4d4', '#949494', '#939393'],
            ['#bdbdbd', '#b9b9b9', '#858585'],
        ],
        Red: [
            ['#ffaacc', '#ff297f', '#ff287e'],
            ['#ff7cb0', '#ff73ab', '#ff0b6d'],
        ],
        Green: [
            ['#aaffe2', '#29ffb6', '#28ffb6'],
            ['#7cffd2', '#73ffcf', '#0bffac'],
        ],
        Blue: [
            ['#aaaaff', '#2929ff', '#2828ff'],
            ['#7c7cff', '#7373ff', '#0b0bff'],
        ],
        Yellow: [
            ['#ffe6aa', '#ffc029', '#ffc028'],
            ['#ffd87c', '#ffd673', '#ffb70b'],
        ],
        Purple: [
            ['#e8aaff', '#c529ff', '#c528ff'],
            ['#dc7cff', '#d973ff', '#bd0bff'],
        ],
        Cyan: [
            ['#aaf6ff', '#29e8ff', '#28e8ff'],
            ['#7cf1ff', '#73f0ff', '#0be5ff'],
        ],
        Black: [
            ['#636363', '#3d3d3d', '#3d3d3d'],
            ['#484848', '#454545', '#3d3d3d'],
        ],
    },
    // The judgment line per colour: [edge, centre], the gradient running between them from the
    // stage edge to the centre. Its band is one black at 0.57 for every colour.
    judgmentLine: {
        Neutral: ['#afafaf', '#cacaca'],
        Red: ['#ff186f', '#fa72ab'],
        Green: ['#4dff00', '#b1ff00'],
        Blue: ['#009fff', '#00dfff'],
        Yellow: ['#ffff00', '#ecff9b'],
        Purple: ['#c85fff', '#a694ff'],
        Cyan: ['#00f9ff', '#8ffcff'],
        Black: ['#000000', '#222222'],
    },
    judgmentBand: ['#000000', 0.57],
    // The standard ticks' and directional markers' faces, per standard colour.
    tick: { Neutral: '#e8e8e8', Blue: '#a2a2fa', Cyan: '#a2fafa', Purple: '#faa2fa' },
    marker: {
        Neutral: '#a1a1a1',
        Green: '#7eed7e',
        Blue: '#7e7eed',
        Purple: '#ed7eed',
        Cyan: '#7eeded',
    },
    // Effects, from captures of each hit: the hue where the effects add light.
    effect: { tap: '#6266f2', flick: '#e640bc', trace: '#39b2e6' },
    // Per style: connector at rest and held, critical connector at rest and held, damage
    // connector, slot glow, critical slot glow, flick arrow.
    style: {
        Neutral: [
            '#c1c1c1',
            '#b3b3b3',
            '#eeeeee',
            '#cdcdcd',
            '#acacac',
            '#aeaeae',
            '#d8d8d8',
            '#b5b5b5',
        ],
        Red: [
            '#ff83b5',
            '#ff67a4',
            '#ffdeeb',
            '#ff9cc4',
            '#e573a1',
            '#ff5d9e',
            '#ffb2d0',
            '#ee7eaa',
        ],
        Green: [
            '#83ffd5',
            '#67ffcb',
            '#defff4',
            '#9cffdd',
            '#73e5bf',
            '#5dffc7',
            '#b2ffe4',
            '#7eeec7',
        ],
        Blue: [
            '#8383ff',
            '#6767ff',
            '#dedeff',
            '#9c9cff',
            '#7373e5',
            '#5d5dff',
            '#b2b2ff',
            '#7e7eee',
        ],
        Yellow: [
            '#ffdb83',
            '#ffd267',
            '#fff5de',
            '#ffe29c',
            '#e5c473',
            '#ffcf5d',
            '#ffe8b2',
            '#eecd7e',
        ],
        Purple: [
            '#dd83ff',
            '#d667ff',
            '#f6deff',
            '#e49cff',
            '#c773e5',
            '#d35dff',
            '#eab2ff',
            '#cf7eee',
        ],
        Cyan: [
            '#83f2ff',
            '#67efff',
            '#defcff',
            '#9cf5ff',
            '#73dae5',
            '#5deeff',
            '#b2f7ff',
            '#7ee2ee',
        ],
        Black: [
            '#4b4b4b',
            '#424242',
            '#acacac',
            '#585858',
            '#424242',
            '#404040',
            '#6b6b6b',
            '#484848',
        ],
    },
}

/** The editor's stage colours (the preview navy, the stage stroke and the accent). */
export const stage = { navy: '#292b42', lane: '#1c1e31', stroke: '#b4d6e8', accent: '#77efdc' }

/** The red, green and blue levels of a #rrggbb colour. */
export const channels = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16))

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
