// What pins the v1 fixtures from outside their folders. Each folder's SHA256SUMS is rewritten by the
// writer on every run, so the folder alone cannot say a regeneration happened; these constants can.
//
// They only ever grow. A fixture added later (format-versioning.md section 8, "A gap found later")
// gets its build added to FIXTURE_BUILDS and its folder's SHA256SUMS digest replaced here in the
// same commit; no existing fixture is ever replaced, and an existing file's line in SHA256SUMS stays.

/** The editor build the fixtures were written by: the `appVersion` of every file and dump. */
export const FIXTURE_BUILDS: readonly string[] = ['0.5.22+98fb393c']

/**
 * The commit the fixtures are confirmed at: the build that wrote them, or a later commit at which a
 * maintainer checked that the format paths changed since hold nothing a v1 file or row contains.
 * `npm run release:tag -- 0.6.0` stops when a format path changed since it (scripts/release/rules.mjs
 * `fixturePaths`), and when it is not in the history of the commit tagged: merge with a merge commit.
 */
export const FIXTURES_CONFIRMED_AT = 'f734cd55'

/** The SHA-256 of each folder's SHA256SUMS file. */
export const SUMS_DIGESTS: Readonly<Record<'nxsp-v1' | 'web-storage-v1', string>> = {
    'nxsp-v1': '0763c9107396f2f4276968ea4370b089ac48fadfe470104065ad6bad77c87f66',
    'web-storage-v1': '76793828dbac34e99d957dd672bebcc46fe9e4eb79d37b9aa7b35d744c3df167',
}
