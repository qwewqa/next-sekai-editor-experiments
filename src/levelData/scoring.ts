import {
    beatToTicks,
    scheduleHiddenTicks,
    type SlideInfos,
} from '../state/entities/slides/hiddenTicks'
import { getNoteRole, type SlideNoteInfo } from '../state/entities/slides/semantics'

/** The breakdown's rows, in display order. Fake Note is outside Combo. */
export const ROWS = [
    'tap',
    'flick',
    'release',
    'trace',
    'traceFlick',
    'tick',
    'hiddenTick',
    'damageNote',
    'damageTick',
    'fakeNote',
] as const
export type Row = (typeof ROWS)[number]

/** The chart's categories, in the list's order and the stack's order from the bottom. */
export const CATEGORIES = [
    'tap',
    'flick',
    'release',
    'trace',
    'traceFlick',
    'tick',
    'damage',
] as const
export type Category = (typeof CATEGORIES)[number]

/** The chart category a scored row counts in. */
export const categoryOf = (row: Exclude<Row, 'fakeNote'>): Category =>
    row === 'hiddenTick' ? 'tick' : row === 'damageNote' || row === 'damageTick' ? 'damage' : row

/** The row of an exported note, or undefined for an anchor. Fake notes are Fake Note. */
export const classifyNote = (info: SlideNoteInfo): Row | undefined => {
    const role = getNoteRole(info)
    if (role === 'anchor') return undefined
    if (info.note.isFake) return 'fakeNote'
    const isFlick = info.note.flickDirection !== 'none'
    switch (role) {
        case 'damage':
            return 'damageNote'
        case 'tick':
            return 'tick'
        case 'trace':
        case 'headTrace':
        case 'tailTrace':
            return isFlick ? 'traceFlick' : 'trace'
        case 'tail':
            return isFlick ? 'flick' : 'release'
        case 'single':
        case 'head':
            return isFlick ? 'flick' : 'tap'
    }
}

export const inCombo = (row: Row): row is Exclude<Row, 'fakeNote'> => row !== 'fakeNote'

export const forEachExported = (
    infos: SlideInfos,
    visit: (row: Row, beat: number, info?: SlideNoteInfo) => void,
) => {
    for (const info of infos) {
        const row = classifyNote(info)
        if (row !== undefined) visit(row, info.note.beat, info)
    }
    for (const tick of scheduleHiddenTicks(infos)) {
        visit(
            tick.connectorType === 'active' ? 'hiddenTick' : 'damageTick',
            tick.tick / beatToTicks,
        )
    }
}
