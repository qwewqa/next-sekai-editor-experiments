// Pinned `.nxsp` constants (§1.6.11.8); `tests/local/formatVersions.test.ts` asserts each. What
// each number guards, and the checklist for changing a format, is `docs/format-versioning.md`.

/** `project.json`'s `format`: how Open recognises a project file. */
export const NXSP_FORMAT = 'nxsp'

/** `project.json`'s `version`: the major version. */
export const NXSP_VERSION = 1

/**
 * `project.json`'s `minor`: the reader generation this build is. A change an older reader would
 * misread (a merge revision) raises it, and an older reader then leaves the history unread.
 */
export const NXSP_MINOR = 1

/**
 * `project.json`'s `patch`: the additive generation this build is. Content an older reader can
 * leave out without misreading what remains (a new ZIP entry, a `parts` key, an `x` carrier a
 * build starts to write) raises it. An older reader opens such a file normally, keeps its
 * history, and says once that some content may not be shown.
 */
export const NXSP_PATCH = 0

/** `history/manifest.json`'s `version`. */
export const MANIFEST_VERSION = 2

/**
 * The `minor` that introduced each thing a file can use (§1.6.11.8): the writer writes the
 * maximum over what it writes. A table entry is a `minor` only for what an older reader would
 * MISREAD (the v1 `manifestVersion` 2, a merge revision). Anything it merely cannot show is
 * additive: it goes in as 0 here and in `PATCH_TABLE` with the `patch` that introduces it (a new
 * ZIP entry kind, a `parts` key), and `tests/local/formatVersions.test.ts` keeps the two tables'
 * keys equal. In v1 every other thing maps to 0; a later version adds its entries.
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

/**
 * The `patch` that introduced each additive thing a file can hold. Its `zipEntry` keys are
 * `MINOR_TABLE.zipEntry`'s; a new entry kind or `parts` key is added to both, here with the
 * `patch` it ships in. Every one is 0 in v1.
 */
export const PATCH_TABLE = {
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

/** The lowest `patch` that holds what a write uses; throws on anything the table lacks. */
export const patchOf = (use: { zipEntries: Iterable<string>; partsKeys?: Iterable<string> }) => {
    let patch = 0
    for (const name of use.zipEntries) {
        const key = zipEntryKind(name) ?? name
        const value = PATCH_TABLE.zipEntry[key]
        if (value === undefined) throw new Error(`No patch for ${key}`)
        patch = Math.max(patch, value)
    }
    for (const key of use.partsKeys ?? []) {
        const value = PATCH_TABLE.partsKey[key]
        if (value === undefined) throw new Error(`No patch for parts.${key}`)
        patch = Math.max(patch, value)
    }
    return patch
}

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
