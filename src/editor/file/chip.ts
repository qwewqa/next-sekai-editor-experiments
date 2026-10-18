// The one chip slot's states and their order (Part 1 §1.3.4, §1.4.19): the same list on every
// platform; the web raises the first, second, fourth and sixth.

export type ChipKind =
    'notStored' | 'fileMissing' | 'changedOnDisk' | 'newerOnDisk' | 'notConfirmed'

/** Highest priority first. */
export const CHIP_ORDER: readonly ChipKind[] = [
    'notStored',
    'fileMissing',
    'changedOnDisk',
    'newerOnDisk',
    'notConfirmed',
]

/** Drawn by severity, never a glyph in the string. */
export const chipSeverity = (kind: ChipKind): 'warning' | 'info' =>
    kind === 'newerOnDisk' || kind === 'notConfirmed' ? 'info' : 'warning'

/** The raised states in priority order: the first is the chip, the rest are lines in its dialog. */
export const chipStates = (raised: Iterable<ChipKind>) => {
    const set = new Set(raised)
    return CHIP_ORDER.filter((kind) => set.has(kind))
}

/** A row's badge: its state, or "Open in another tab or window" (§1.4.19). */
export type Badge = ChipKind | 'openElsewhere'

/** A row shows at most two badges: its state first, then "Open in another tab or window". */
export const rowBadges = (raised: Iterable<ChipKind>, openElsewhere: boolean): Badge[] => {
    const [state] = chipStates(raised)
    const badges: Badge[] = state ? [state] : []
    if (openElsewhere) badges.push('openElsewhere')
    return badges
}
