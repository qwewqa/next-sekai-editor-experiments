// What pins the v1 fixtures from outside their folders. Each folder's SHA256SUMS is rewritten by the
// writer on every run, so the folder alone cannot say a regeneration happened; these constants can.
//
// After the ship they only grow. A fixture added later (format-versioning.md section 8, "A gap found later")
// gets its build added to FIXTURE_BUILDS and its folder's SHA256SUMS digest replaced here in the
// same commit; no existing fixture is ever replaced, and an existing file's line in SHA256SUMS stays.

/** The editor build the fixtures were written by: the `appVersion` of every file and dump. */
export const FIXTURE_BUILDS: readonly string[] = ['0.5.22+9ed545fb']

/**
 * The commit the fixtures are confirmed at: the build that wrote them, or a later commit at which a
 * maintainer checked that the format paths changed since hold nothing a v1 file or row contains.
 * `npm run release:tag -- 0.6.0` stops when a format path changed since it (scripts/release/rules.mjs
 * `fixturePaths`), and when it is not in the history of the commit tagged: merge with a merge commit.
 */
export const FIXTURES_CONFIRMED_AT = '9ed545fb'

/** The SHA-256 of each folder's SHA256SUMS file. */
export const SUMS_DIGESTS: Readonly<Record<'nxsp-v1' | 'web-storage-v1', string>> = {
    'nxsp-v1': 'c7cacc0d509f7c2481fecdfdd259567c7617a4262230b5de547eba6ae584f308',
    'web-storage-v1': 'fe0117f91cd6fc29587c2fc2e698ad40a0a2d97542f64163c135a7eed7e889e5',
}
