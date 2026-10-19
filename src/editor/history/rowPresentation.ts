import { interpolateRaw } from '../../utils/interpolate'
import type { EntryRow, Row } from './rows'

type Strings = {
    edits: string
    undidSteps: string
    redidSteps: string
    undo: string
    redo: string
}

export const isCountedParent = (row: EntryRow) =>
    !row.child && (row.members.length > 1 || !!row.partial)

/** Stored action text and recorded membership remain separate quantities. */
export const presentRow = (row: EntryRow, strings: Strings) => {
    const { kind, label } = row.entry
    if (isCountedParent(row)) {
        const count = interpolateRaw(
            kind === 'undo'
                ? strings.undidSteps
                : kind === 'redo'
                  ? strings.redidSteps
                  : strings.edits,
            `${row.members.length}${row.partial ? '+' : ''}`,
        )
        const action = kind === 'edit' && label.trim() ? label : undefined
        return {
            main: action ?? count,
            count: action ? count : undefined,
            full: action ? `${action} · ${count}` : count,
        }
    }
    const main =
        kind === 'undo'
            ? `${strings.undo} · ${label}`
            : kind === 'redo'
              ? `${strings.redo} · ${label}`
              : label
    return { main, count: undefined, full: main }
}

/** Fixed heights drive both window offsets and the rendered rows. */
export const heightOf = (row: Row) =>
    row.type === 'header'
        ? 28
        : row.type === 'divider'
          ? 32
          : row.type === 'entry' && isCountedParent(row) && !row.selectable
            ? 80
            : 44
