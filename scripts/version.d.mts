export type AppVersion = {
    /** `X.Y.Z` of the newest reachable tag, or `package.json`'s without tags. */
    version: string
    /** `X.Y.Z` at the tag, `X.Y.Z+<commit8>` after it, or `package.json`'s without tags. */
    appVersion: string
    /** Whether HEAD is the tagged commit; false for the `package.json` fallback. */
    atTag: boolean
}

export function appVersion(options?: { cwd?: string }): AppVersion

export function isHighestTag(tag: string, tags: readonly string[]): boolean

export function parseTag(tag: string): [number, number, number] | null

export function compareVersions(a: readonly number[], b: readonly number[]): number
