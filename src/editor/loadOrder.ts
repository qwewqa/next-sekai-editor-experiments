// The order of the load notices (Part 1 §1.4.3's table, most important first).
export const LOAD_ORDER = {
    continued: 10,
    storageCleared: 20,
    // The handshake's: other tabs hold an upgrade, or the database is newer than this build.
    handshake: 30,
    journalKept: 50,
    unsavedRecovered: 60,
    unsavedInLocalData: 70,
    journalsFull: 75,
    migrationFailed: 80,
    migrated: 90,
    migratedRevision: 95,
    journalRecovered: 100,
    journalLater: 110,
    journalFailed: 115,
    // A resumed import found damage in the continued session's file (§1.6.11.8).
    damagedHistory: 145,
    bgmNotLoaded: 150,
    openElsewhere: 160,
    deletedElsewhere: 165,
    notOpened: 167,
    separateCopy: 170,
} as const
