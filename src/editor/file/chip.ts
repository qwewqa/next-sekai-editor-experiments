// The one chip slot's states and their order: the same list on every
// platform.

export type ChipKind = 'notStored' | 'fileMissing' | 'changedOnDisk' | 'newerOnDisk'

/** Highest priority first. */
export const CHIP_ORDER: readonly ChipKind[] = [
    'notStored',
    'fileMissing',
    'changedOnDisk',
    'newerOnDisk',
]

/** Drawn by severity, never a glyph in the string. */
export const chipSeverity = (kind: ChipKind): 'warning' | 'info' =>
    kind === 'newerOnDisk' ? 'info' : 'warning'

/** The raised states in priority order: the first is the chip, the rest are lines in its dialog. */
export const chipStates = (raised: Iterable<ChipKind>) => {
    const set = new Set(raised)
    return CHIP_ORDER.filter((kind) => set.has(kind))
}

/** A row's badge: its state, or "Open in another tab or window". */
export type Badge = ChipKind | 'openElsewhere'

/** A row shows at most two badges: its state first, then "Open in another tab or window". */
export const rowBadges = (raised: Iterable<ChipKind>, openElsewhere: boolean): Badge[] => {
    const [state] = chipStates(raised)
    const badges: Badge[] = state ? [state] : []
    if (openElsewhere) badges.push('openElsewhere')
    return badges
}
