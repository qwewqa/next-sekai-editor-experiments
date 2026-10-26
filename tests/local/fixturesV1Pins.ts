// What pins the v1 fixtures from outside their folders. Each folder's SHA256SUMS is rewritten by the
// writer on every run, so the folder alone cannot say a regeneration happened; these constants can.
//
// They only ever grow. A fixture added later (format-versioning.md section 8, "A gap found later")
// gets its build added to FIXTURE_BUILDS and its folder's SHA256SUMS digest replaced here in the
// same commit; no existing fixture is ever replaced, and an existing file's line in SHA256SUMS stays.

/** The editor build the fixtures were written by: the `appVersion` of every file and dump. */
export const FIXTURE_BUILDS: readonly string[] = ['0.5.22+0d503931']

/**
 * The commit the fixtures are confirmed at: the build that wrote them, or a later commit at which a
 * maintainer checked that the format paths changed since hold nothing a v1 file or row contains.
 * `npm run release:tag -- 0.6.0` stops when a format path changed since it (scripts/release/rules.mjs
 * `fixturePaths`), and when it is not in the history of the commit tagged: merge with a merge commit.
 */
export const FIXTURES_CONFIRMED_AT = '0d503931'

/** The SHA-256 of each folder's SHA256SUMS file. */
export const SUMS_DIGESTS: Readonly<Record<'nxsp-v1' | 'web-storage-v1', string>> = {
    'nxsp-v1': 'a90b1568fb6b76179a07fcc672f16a0ef72314368dfecf4ab3d6c34006a0a287',
    'web-storage-v1': '6d96a815fe72ee271a45f9e869dfc914d756f6f11e915c93c6e3c482e09d078c',
}
