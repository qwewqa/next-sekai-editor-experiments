import {
    captureOperationRecipe,
    memberLang,
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
 * Row recipes kept from one build to the next. A recipe depends only on the row's
 * members, `partial` and `child`, and entries are never changed in place, so a row with the same
 * `partial`, `child` and member objects as before reuses its recipe. Rows a build leaves out stay
 * kept, so a filter turned off again (Show All) reuses theirs, until the cache holds more than
 * `limit` rows and twice the rows built; it then keeps only those.
 */
export const createRecipeCache = (limit = 20_000) => {
    let kept = new Map<string, { row: EntryRow; recipe: OperationRecipe }>()
    return (rows: readonly Row[]): ReadonlyMap<string, OperationRecipe> => {
        const recipes = new Map<string, OperationRecipe>()
        for (const row of rows) {
            if (row.type !== 'entry') continue
            const old = kept.get(row.id)
            const recipe =
                old &&
                !!old.row.partial === !!row.partial &&
                old.row.child === row.child &&
                old.row.members.length === row.members.length &&
                old.row.members.every((member, i) => member === row.members[i])
                    ? old.recipe
                    : recipeOfRow(row)
            kept.set(row.id, { row, recipe })
            recipes.set(row.id, recipe)
        }
        if (kept.size > Math.max(limit, 2 * recipes.size))
            kept = new Map([...kept].filter(([id]) => recipes.has(id)))
        return recipes
    }
}

/**
 * The one device formatter for rows: "Saved on iPad" for an app device, "Saved in the web editor
 * (Chrome)" for a web label, which is never shown raw. A web label is
 * "Web (Chrome)", or "Web" when the browser is not known.
 */
export const savedOnText = (context: OperationTextContext, label: string) => {
    const { history } = context.strings
    const web = /^Web(?: \((.*)\))?$/.exec(label)
    if (!web) return interpolateRaw(history.savedOn, label)
    return web[1] ? interpolateRaw(history.savedWeb, web[1]) : history.savedWebAny
}

/**
 * A save made on another device names it: the entry's `device.id` is not this
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
    // The captured language of a newer or unreadable step's own text, for the `lang` of its element.
    const lang =
        !device && recipe.kind === 'single' && recipe.members[0]
            ? memberLang(recipe.members[0], context)
            : undefined
    return { main, steps, ...(lang ? { lang } : {}), full: steps ? `${main} · ${steps}` : main }
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
