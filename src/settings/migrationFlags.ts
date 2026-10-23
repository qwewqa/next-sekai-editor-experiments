/** The one list of web migration flags: localStorage keys that mark a migration done, not a user choice. */
export const WEB_MIGRATION_FLAGS: readonly string[] = [
    'toolbarEditorLayoutMigrated',
    'toolbarExportMigrated',
    'toolbarPreviewAssetsMigrated',
    'toolbarSessionRestoreMigrated',
]

/** Other keys the editor writes on its own, which a new visitor has too. */
export const INTERNAL_KEYS: readonly string[] = ['diagnostics']

/** Whether a key (without the editor's prefix) is a flag or internal state rather than the user's own. */
export const isInternalKey = (key: string) =>
    WEB_MIGRATION_FLAGS.includes(key) || INTERNAL_KEYS.includes(key)
