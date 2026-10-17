// What a package from a file or a server may hold (Part 2, 2.5.5). Sizes the plan gives in MB
// are decimal, so a message states them as they are.

const KiB = 1024
const MB = 1000 * 1000

export const LIMITS = {
    /** A package file: ZIP32 only */
    file: 2 * 1024 * 1024 * KiB,
    entries: 20_000,
    /** An entry name's length in bytes */
    entryName: KiB,
    /** The most an entry may expand to, for entries past `ratioFloor` */
    ratio: 200,
    ratioFloor: 64 * KiB,
    /** A list or details entry, and a background's configuration once inflated */
    json: 4 * MB,
    /** A data entry, gzipped, and inflated */
    dataGzip: 16 * MB,
    dataInflated: 64 * MB,
    /** The details entries read to list a package that has no list entry */
    listing: 16 * MB,
    skinSprites: 20_000,
    particleSprites: 4096,
    particleEffects: 4096,
    /** `count × particles` of an effect, and its particles and its groups */
    particlesPerEffect: 512,
    /** The particles, and the groups, of all a particle's effects together */
    particlesInAll: 32_768,
    textureSide: 4096,
    backgroundSide: 4096,
    thumbnailSide: 1024,
    thumbnail: 8 * MB,
    effectAudio: 32 * MB,
    effectEntries: 64,
    clip: 8 * MB,
    /** All decoded clips together, in seconds */
    decodedSeconds: 120,
    /** All decoded clips together, as 32-bit samples at 48 kHz */
    decodedBytes: 64 * MB,
    /** One stored package after repack */
    package: 64 * MB,
    /** Titles and authors */
    text: 200,
    /** Items a package lists in the chooser */
    listed: 1000,
}
