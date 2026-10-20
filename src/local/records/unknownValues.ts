import { RECORDS_V, SESSION_V } from './version'

// What this build does with a value it doesn't know in an enum field of a stored row
// (§1.6.11.2's table), so a stale tab or an older build never guesses, and which sessions
// and chains are "Needs a newer version" (§1.6.11.8).

const known = <T extends string>(values: readonly T[], value: unknown): value is T =>
    (values as readonly unknown[]).includes(value)

export const sessionOrigins = [
    'new',
    'import',
    'nxsp',
    'continued',
    'migrated',
    'journal',
    'replaced',
] as const
export type SessionOrigin = (typeof sessionOrigins)[number]

/** `origin`: an unknown value reads as an ordinary session (`undefined` here). */
export const readOrigin = (value: unknown): SessionOrigin | undefined =>
    known(sessionOrigins, value) ? value : undefined

export const fileEvents = ['opened', 'saved', 'downloaded'] as const
export type FileEvent = (typeof fileEvents)[number]

/**
 * `file.event`: an unknown value is `downloaded` without `confirmed`, so it counts as not
 * saved to a file and keeps that protection.
 */
export const readFileEvent = (
    event: unknown,
    confirmed: unknown,
): { event: FileEvent; confirmed: boolean } =>
    known(fileEvents, event)
        ? { event, confirmed: confirmed === true }
        : { event: 'downloaded', confirmed: false }

export const mediaKinds = ['bgm', 'cover', 'preview'] as const
export type MediaKind = (typeof mediaKinds)[number]

/** `media.kind`: an unknown value is still media, reachable by `refs` as usual (`undefined` here). */
export const readMediaKind = (value: unknown): MediaKind | undefined =>
    known(mediaKinds, value) ? value : undefined

export const userAssetTypes = ['skin', 'particle', 'background', 'effect'] as const
export type UserAssetType = (typeof userAssetTypes)[number]

/** `userAssets.type`: an unknown value isn't listed, and Manage… never removes it. */
export const isListedUserAsset = (type: unknown): type is UserAssetType =>
    known(userAssetTypes, type)

/** `tombstones.kind`: an unknown value is kept, not shown. */
export const isShownTombstone = (kind: unknown) => kind === 'session'

/** `recovered.source`: a row of any source, known or not, is listed as unreadable recovered work. */
export const recoveredSources = ['journal', 'journalFile'] as const

/** `nodes.t`: an unknown value makes GC abort, as for an unknown `v`. */
export const isKnownNodeType = (t: unknown): t is 'root' | 'node' => t === 'root' || t === 'node'

export const entryKinds = [
    'init',
    'continue',
    'edit',
    'undo',
    'redo',
    'restore',
    'save',
    'export',
    'recovered',
] as const
export type EntryKind = (typeof entryKinds)[number]

/** `entries.kind`: an unknown value makes its session "Needs a newer version". */
export const isKnownEntryKind = (kind: unknown): kind is EntryKind => known(entryKinds, kind)

/**
 * A root `v` this build reads. Above `RECORDS_V` it is newer (`isNewerRootVersion`); not a
 * positive integer, or 0, it is malformed, which is damage, never "newer".
 */
export const isReadableRootVersion = (v: unknown) =>
    Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= RECORDS_V

/** Only the current session generation is supported; older experimental rows remain untouched. */
export const isReadableSessionVersion = (v: unknown) => v === SESSION_V

/** A session `v` above this build's: a newer build wrote it, so it "needs a newer version". */
export const isNewerSessionVersion = (v: unknown) =>
    Number.isSafeInteger(v) && (v as number) > SESSION_V

/** A root `v` above this build's `RECORDS_V`: a newer build wrote it. */
export const isNewerRootVersion = (v: unknown) =>
    Number.isSafeInteger(v) && (v as number) > RECORDS_V

/** What deciding a session's readability needs. */
export type SessionReadability = {
    row: { v?: unknown }
    /** The kinds of its entries, as far as they're read. */
    entryKinds?: Iterable<unknown>
    /** The `v` of every root its entries name, as far as they're read. */
    rootVersions?: Iterable<unknown>
}

/**
 * How this build stands to a session (§1.6.11.8): `readable`; `newer`, written by a newer build
 * (a session `v` or root `v` above this build's, an unknown entry kind), which reads as "Needs a
 * newer version"; or `unsupported`, an older or malformed generation that this build does not
 * read either, and says so plainly instead of calling it newer. Newer wins when both are found.
 */
export type Readability = 'readable' | 'newer' | 'unsupported'

export const sessionReadability = ({
    row,
    entryKinds = [],
    rootVersions = [],
}: SessionReadability): Readability => {
    let result: Readability = 'readable'
    if (!isReadableSessionVersion(row.v)) {
        if (isNewerSessionVersion(row.v)) return 'newer'
        result = 'unsupported'
    }
    for (const kind of entryKinds) if (!isKnownEntryKind(kind)) return 'newer'
    for (const v of rootVersions) {
        if (isReadableRootVersion(v)) continue
        if (isNewerRootVersion(v)) return 'newer'
        result = 'unsupported'
    }
    return result
}

/** Whether this build can read a session: never continued, restored or rewritten otherwise. */
export const isReadableSession = (session: SessionReadability) =>
    sessionReadability(session) === 'readable'

/**
 * Whether this build can read a chain: one session it can't read makes the whole chain
 * "Needs a newer version" (§1.6.11.8): never continued, restored, reduced, swept or saved.
 */
export const isReadableChain = (sessions: Iterable<SessionReadability>) => {
    for (const session of sessions) if (!isReadableSession(session)) return false
    return true
}
