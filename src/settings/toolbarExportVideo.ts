/** The group `toolbarExportVideoMigrated` looks for: the default first group before Export Video. */
const formerFirst = [
    'utilities',
    'statistics',
    'properties',
    'reset',
    'exportLevel',
    'saveAs',
    'save',
    'open',
]

/**
 * The toolbar step `toolbarExportVideoMigrated`: Export Video goes beside Export Level Data, on
 * the side away from Open, the face, in a group that exactly matches the old default first group.
 * A customised toolbar, or one that has the command, is left as it is.
 */
export const insertExportVideo = (groups: unknown[][]): unknown[][] => {
    if (groups.some((group) => group.includes('exportVideo'))) return groups
    const index = groups.findIndex(
        (group) =>
            group.length === formerFirst.length &&
            group.every((name, at) => name === formerFirst[at]),
    )
    if (index === -1) return groups
    return groups.map((group, i) => {
        if (i !== index) return group
        const at = group.indexOf('exportLevel')
        return [...group.slice(0, at), 'exportVideo', ...group.slice(at)]
    })
}
