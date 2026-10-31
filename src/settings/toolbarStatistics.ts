/** The group `toolbarStatisticsMigrated` looks for: the first group before Statistics joined it. */
const formerFirst = ['utilities', 'properties', 'reset', 'exportLevel', 'saveAs', 'save', 'open']

/**
 * The toolbar step `toolbarStatisticsMigrated`: Statistics goes before Level Info in a group that
 * exactly matches the old default first group, so Open stays its face. A customised toolbar, or one
 * that has the command, is left as it is.
 */
export const insertStatistics = (groups: unknown[][]): unknown[][] => {
    if (groups.some((group) => group.includes('statistics'))) return groups
    const index = groups.findIndex(
        (group) =>
            group.length === formerFirst.length &&
            group.every((name, at) => name === formerFirst[at]),
    )
    if (index === -1) return groups
    return groups.map((group, i) => {
        if (i !== index) return group
        const at = group.indexOf('properties')
        return [...group.slice(0, at), 'statistics', ...group.slice(at)]
    })
}
