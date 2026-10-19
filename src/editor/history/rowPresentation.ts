import {
    captureOperationRecipe,
    operationStepCount,
    renderOperationRecipe,
    type OperationRecipe,
    type OperationTextContext,
} from '../../history/operationPresentation'
import type { EntryRow, Row } from './rows'
import { entryId } from './rows'

export const isCountedParent = (row: EntryRow) =>
    !row.child && (row.members.length > 1 || !!row.partial)

export const recipeOfRow = (row: EntryRow): OperationRecipe =>
    captureOperationRecipe(
        [...row.members].reverse().map((entry) => ({
            description: entry,
            id: entryId(entry),
            time: entry.time,
        })),
        {
            partial: !!row.partial,
            ...(isCountedParent(row) && (row.entry.kind === 'undo' || row.entry.kind === 'redo')
                ? { direction: row.entry.kind }
                : {}),
        },
    )

export const presentRow = (
    row: EntryRow,
    context: OperationTextContext,
    recipe = recipeOfRow(row),
) => {
    const main = renderOperationRecipe(recipe, context)
    const count = recipe.kind === 'group' ? operationStepCount(recipe, context) : undefined
    return { main, count, full: count ? `${main} · ${count}` : main }
}

/** Fixed heights drive both window offsets and the rendered rows. */
export const heightOf = (row: Row) =>
    row.type === 'header' || row.type === 'count'
        ? 28
        : row.type === 'divider'
          ? 32
          : row.type === 'entry' && !row.selectable
            ? 80
            : 44
