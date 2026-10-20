import {
    captureOperationRecipe,
    operationStepCount,
    renderOperationRecipe,
    type OperationRecipe,
    type OperationTextContext,
} from '../../history/operationPresentation'
import { decodeOperation } from '../../history/operations'
import { interpolateRaw } from '../../utils/interpolate'
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

/**
 * The one device formatter for rows: "Saved on iPad" for an app device, "Saved in the web editor
 * (Chrome)" for a web label, which is never shown raw (Part 0 §0.9.3). A web label is
 * "Web (Chrome)", or "Web" when the browser is not known (§1.3.3).
 */
export const savedOnText = (context: OperationTextContext, label: string) => {
    const { history } = context.strings
    const web = /^Web(?: \((.*)\))?$/.exec(label)
    if (!web) return interpolateRaw(history.savedOn, label)
    return web[1] ? interpolateRaw(history.savedWeb, web[1]) : history.savedWebAny
}

/**
 * A save made on another device names it (§1.4.10.5): the entry's `device.id` is not this
 * browser's `thisDevice`. A download is not a save of another device's: it reads as it does.
 */
const otherDevice = (row: EntryRow, thisDevice: string | undefined) => {
    const { entry } = row
    if (entry.kind !== 'save' || !entry.device || thisDevice === undefined) return
    if (entry.device.id === thisDevice) return
    const decoded = decodeOperation(entry.operation)
    const download =
        decoded.status === 'known' &&
        decoded.operation.id === 'nse.file.save' &&
        decoded.operation.data.delivery === 'download'
    return download ? undefined : entry.device
}

export const presentRow = (
    row: EntryRow,
    context: OperationTextContext,
    recipe = recipeOfRow(row),
    thisDevice?: string,
) => {
    const device = otherDevice(row, thisDevice)
    const main = device
        ? savedOnText(context, device.label)
        : renderOperationRecipe(recipe, context)
    const steps = recipe.kind === 'group' ? operationStepCount(recipe, context) : undefined
    return { main, steps, full: steps ? `${main} · ${steps}` : main }
}

/**
 * Fixed heights drive both window offsets and the rendered rows. They are px at the 16 px rem; k (the
 * root font size / 16) scales them as the rows’ classes scale.
 */
export const heightOf = (row: Row, k = 1) =>
    (row.type === 'header'
        ? 28
        : row.type === 'divider'
          ? 32
          : row.type === 'entry' && !row.selectable
            ? 80
            : 44) * k
