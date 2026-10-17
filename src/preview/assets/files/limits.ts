// What a package from a file or a server may hold (Part 2, 2.5.5).

const KiB = 1024
const MiB = 1024 * KiB

export const LIMITS = {
    /** A package file: ZIP32 only */
    file: 2 * 1024 * MiB,
    entries: 20_000,
    /** The most an entry may expand to, for entries past `ratioFloor` */
    ratio: 200,
    ratioFloor: 64 * KiB,
    /** A list or details entry */
    json: 4 * MiB,
    /** A data entry, gzipped, and inflated */
    dataGzip: 16 * MiB,
    dataInflated: 64 * MiB,
    skinSprites: 20_000,
    particleSprites: 4096,
    particleEffects: 4096,
    /** `count × particles` of an effect */
    particlesPerEffect: 512,
    textureSide: 4096,
    backgroundSide: 4096,
    thumbnailSide: 1024,
    effectAudio: 32 * MiB,
    effectEntries: 64,
    clip: 8 * MiB,
    /** All decoded clips together, in seconds */
    decodedSeconds: 120,
    /** One stored package after repack */
    package: 64 * MiB,
    /** Titles and authors */
    text: 200,
    /** Items a package lists in the chooser */
    listed: 1000,
}
