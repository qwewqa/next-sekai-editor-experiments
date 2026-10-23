/** The group `toolbarMinimapMigrated` looks for: the navigation group before Minimap joined it. */
const formerNavigation = [
    'scrollLeft',
    'scrollRight',
    'jumpUp',
    'scrollPageUp',
    'scrollUp',
    'scrollDown',
    'scrollPageDown',
    'jumpDown',
]

/**
 * The toolbar step `toolbarMinimapMigrated` (Part 1 §1.4.6): Minimap goes first in a group that
 * exactly matches the old default navigation group, so Jump to Start stays its face. A
 * customised toolbar, or one that has the command, is left as it is.
 */
export const insertMinimap = (groups: unknown[][]): unknown[][] => {
    if (groups.some((group) => group.includes('minimap'))) return groups
    const index = groups.findIndex(
        (group) =>
            group.length === formerNavigation.length &&
            group.every((name, at) => name === formerNavigation[at]),
    )
    if (index === -1) return groups
    return groups.map((group, i) => (i === index ? ['minimap', ...group] : group))
}
