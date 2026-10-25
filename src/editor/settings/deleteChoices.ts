import type { DeleteChain } from '../../local/deleteSessions'
import { interpolateRaw } from '../../utils/interpolate'

// The pure view of Delete Sessions…: which chains each range picks, the
// counts the dialog shows, and the confirm's lines. Counts and lines come from the same `chosen`,
// so what the dialog promises is what the confirm names and what is deleted.

/** Days; a chain is in range when its last edit is over that many calendar days ago. */
export const RANGES = [1, 7, 30, 90, 'all'] as const
export type DeleteRange = (typeof RANGES)[number]

/** Every opening of the dialog starts here, with the box unticked. */
export const DEFAULT_RANGE: DeleteRange = 90

type Pickable = Pick<DeleteChain, 'ageDays' | 'notSaved'>

export const inRange = (chain: Pickable, range: DeleteRange) =>
    range === 'all' || chain.ageDays > range

/** The chains a range picks; unsaved work only when the box is ticked. */
export const chosen = <T extends Pickable>(
    chains: readonly T[],
    range: DeleteRange,
    includeNotSaved: boolean,
) => chains.filter((chain) => inRange(chain, range) && (includeNotSaved || !chain.notSaved))

/** Each range's count, which follows the box. */
export const rangeCounts = (chains: readonly Pickable[], includeNotSaved: boolean) =>
    RANGES.map((range) => ({ range, count: chosen(chains, range, includeNotSaved).length }))

/** At most this many not-saved names are listed in the confirm. */
export const NAMES_SHOWN = 3

/** The messages the confirm is built from (each a locale string with its plural forms). */
export type ConfirmTexts = {
    /** "Delete {0} session?|Delete {0} sessions?" */
    confirm: string
    /** "{0} session has unsaved changes: {1}.|{0} sessions have unsaved changes: {1}." */
    notSaved: string
    /** "{1} and {0} more": {0} is the count, which picks the plural form. */
    namesMore: string
    /** "This session needs a newer version of the editor.|Some of these sessions need …" */
    newer: string
    /** "{0}, {1}" */
    listJoin: string
    /** A name in the locale's quotes. */
    quoted: string
}

/**
 * The confirm's lines for the chains about to go: the question; the not-saved chains by name (up
 * to three, then "and N more"), only when there are some, which needs the box; and the newer-work
 * line, only when the set holds a chain this build cannot read.
 */
export const confirmLines = <T extends Pickable & Pick<DeleteChain, 'readable'>>(
    targets: readonly T[],
    nameOf: (chain: T) => string,
    texts: ConfirmTexts,
) => {
    const count = String(targets.length)
    const lines = [interpolateRaw(texts.confirm, count)]
    const unsaved = targets.filter((chain) => chain.notSaved)
    if (unsaved.length) {
        const names = unsaved
            .slice(0, NAMES_SHOWN)
            .map((chain) => interpolateRaw(texts.quoted, nameOf(chain)))
            .reduce((text, name) => interpolateRaw(texts.listJoin, text, name))
        const shown =
            unsaved.length > NAMES_SHOWN
                ? interpolateRaw(texts.namesMore, String(unsaved.length - NAMES_SHOWN), names)
                : names
        lines.push(interpolateRaw(texts.notSaved, String(unsaved.length), shown))
    }
    if (targets.some((chain) => chain.readable === 'newer'))
        lines.push(interpolateRaw(texts.newer, count))
    return lines
}
