import type { Category, Row } from '../../levelData/statistics'
import type { NoteShape } from '../../modals/form/noteShapes'

/** Each row's glyph, in the list and on the card. */
export const rowShapes: Record<Row, NoteShape> = {
    tap: 'tap',
    flick: 'flick',
    release: 'release',
    trace: 'trace',
    traceFlick: 'traceFlick',
    tick: 'tick',
    hiddenTick: 'hiddenTick',
    damageNote: 'damage',
    damageTick: 'damageTick',
    fakeNote: 'fake',
}

/**
 * The chart's category colours: chart content, the same in both themes, for its layers, bars
 * and legend swatches.
 */
export const chartCategoryColors: Record<Category, string> = {
    tap: '#8394f6',
    flick: '#e0508e',
    release: '#27bf8c',
    trace: '#5ce29d',
    traceFlick: '#fe9ccb',
    tick: '#44bbdd',
    damage: '#b07ad6',
}
