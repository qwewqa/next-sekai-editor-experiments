/**
 * The toolbar step `toolbarExportMigrated` (Part 1 §1.4.6): Export Level Data goes immediately
 * before Save in whichever group holds it, even a customised one, since Save no longer writes
 * level data. A toolbar that already has it, or has no Save, is left as it is.
 */
export const insertExportLevel = (groups: unknown[][]): unknown[][] => {
    if (groups.some((group) => group.includes('exportLevel'))) return groups
    const index = groups.findIndex((group) => group.includes('save'))
    if (index === -1) return groups
    return groups.map((group, i) => {
        if (i !== index) return group
        const at = group.indexOf('save')
        return [...group.slice(0, at), 'exportLevel', ...group.slice(at)]
    })
}
