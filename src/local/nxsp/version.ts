// Pinned `.nxsp` constants (§1.6.11.8); `tests/local/formatVersions.test.ts` asserts each.

/** `project.json`'s `format`: how Open recognises a project file. */
export const NXSP_FORMAT = 'nxsp'

/** `project.json`'s `version`: the major version. */
export const NXSP_VERSION = 1

/** `project.json`'s `minor`: the reader generation this build is. */
export const NXSP_MINOR = 1

/** `history/manifest.json`'s `version`. */
export const MANIFEST_VERSION = 2

/**
 * The `minor` that introduced each thing a file can use (§1.6.11.8): the writer writes the
 * maximum over what it writes. In v1 every one maps to 0; a later version adds its entries.
 */
export const MINOR_TABLE = {
    levelVersion: { 1: 0 } as Readonly<Record<number, number>>,
    rootV: { 1: 0 } as Readonly<Record<number, number>>,
    manifestVersion: { 2: 1 } as Readonly<Record<number, number>>,
    entryKind: {
        init: 0,
        continue: 0,
        edit: 0,
        undo: 0,
        redo: 0,
        restore: 0,
        save: 0,
        export: 0,
        recovered: 0,
    } as Readonly<Record<string, number>>,
    /** ZIP entries by their kind: the fixed names, and the folders of the rest. */
    zipEntry: {
        'project.json': 0,
        'level.json': 0,
        'history/segments/': 0,
        'history/manifest.json': 0,
        'history/chunks.bin': 0,
        'assets/cover.': 0,
        'assets/preview.': 0,
        'bgm/': 0,
    } as Readonly<Record<string, number>>,
    /** Keys of `parts`: none in v1. */
    partsKey: {} as Readonly<Record<string, number>>,
    /** A revision with more than one parent: none in v1, so it has no entry. */
    merge: undefined as number | undefined,
} as const

/** What a write uses, for its `minor`. */
export type MinorUse = {
    levelVersion: number
    rootVs: Iterable<number>
    manifestVersion?: number
    entryKinds: Iterable<string>
    zipEntries: Iterable<string>
}

const zipEntryKind = (name: string) =>
    Object.keys(MINOR_TABLE.zipEntry).find((key) =>
        key.endsWith('/') || key.endsWith('.') ? name.startsWith(key) : name === key,
    )

/** The lowest `minor` that holds what a write uses; throws on anything the table lacks. */
export const minorOf = (use: MinorUse) => {
    let minor = 0
    const take = (table: Readonly<Record<string | number, number>>, key: string | number) => {
        const value = table[key]
        if (value === undefined) throw new Error(`No minor for ${String(key)}`)
        minor = Math.max(minor, value)
    }
    take(MINOR_TABLE.levelVersion, use.levelVersion)
    for (const v of use.rootVs) take(MINOR_TABLE.rootV, v)
    if (use.manifestVersion !== undefined) take(MINOR_TABLE.manifestVersion, use.manifestVersion)
    for (const kind of use.entryKinds) take(MINOR_TABLE.entryKind, kind)
    for (const name of use.zipEntries) take(MINOR_TABLE.zipEntry, zipEntryKind(name) ?? name)
    return minor
}
