/** The groups `toolbarSessionRestoreMigrated` looks for: the default File and Undo groups before Save As and History joined them. */
const formerFile = ['utilities', 'properties', 'reset', 'exportLevel', 'save', 'open']
const formerUndo = ['paste', 'cut', 'copy', 'redo', 'undo']

const insertInto = (
    groups: unknown[][],
    name: string,
    former: string[],
    before: string,
): unknown[][] => {
    if (groups.some((group) => group.includes(name))) return groups
    const index = groups.findIndex(
        (group) => group.length === former.length && group.every((it, at) => it === former[at]),
    )
    if (index === -1) return groups
    return groups.map((group, i) => {
        if (i !== index) return group
        const at = group.indexOf(before)
        return [...group.slice(0, at), name, ...group.slice(at)]
    })
}

/**
 * The toolbar step `toolbarSessionRestoreMigrated`: Save As goes before Save in
 * a group that exactly matches the old default File group (as step one left it), and History
 * before Redo in one that exactly matches the old default Undo group, so Open and Undo stay the
 * faces. A customised toolbar, or one that has the command, is left as it is.
 */
export const insertSessionRestore = (groups: unknown[][]): unknown[][] =>
    insertInto(insertInto(groups, 'saveAs', formerFile, 'save'), 'history', formerUndo, 'redo')
