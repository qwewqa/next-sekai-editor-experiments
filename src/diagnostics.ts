import { storageGet, storageSet } from './storage'

// The last caught errors and CSP violations (Part 1 §1.4.16): in memory, and in localStorage
// so a reload that follows a crash still has them.
export const RING_KEY = 'diagnostics'
export const RING_SIZE = 20

export type RingEntry = { at: number; kind: 'error' | 'csp'; text: string }

const isEntry = (value: unknown): value is RingEntry =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RingEntry).at === 'number' &&
    ((value as RingEntry).kind === 'error' || (value as RingEntry).kind === 'csp') &&
    typeof (value as RingEntry).text === 'string'

const load = (): RingEntry[] => {
    const stored = typeof localStorage === 'undefined' ? [] : storageGet(RING_KEY, [])
    return Array.isArray(stored) ? stored.filter(isEntry).slice(-RING_SIZE) : []
}

let ring: RingEntry[] | undefined

/** The recorded entries, oldest first. */
export const ringEntries = (): readonly RingEntry[] => (ring ??= load())

/** Records one entry; storage can be full or unavailable, which never matters here. */
export const recordDiagnostic = (kind: RingEntry['kind'], text: string, at = Date.now()) => {
    const clipped = text.slice(0, 2000)
    const last = ringEntries().at(-1)
    // A failure that repeats (a flush retrying) is one entry, so it does not push the rest out.
    if (last?.kind === kind && last.text === clipped) return
    ring = [...ringEntries(), { at, kind, text: clipped }].slice(-RING_SIZE)
    try {
        storageSet(RING_KEY, ring)
    } catch {
        // Kept in memory only.
    }
}

/** Test helper: forgets the in-memory ring so the next read loads from storage. */
export const resetRingForTests = () => {
    ring = undefined
}

const messageOf = (error: unknown) => {
    if (error instanceof Error)
        return error.stack?.split('\n').slice(0, 4).join('\n') ?? error.message
    try {
        return typeof error === 'string' ? error : JSON.stringify(error)
    } catch {
        return String(error)
    }
}

/** Records a caught error, for the places that handle one and carry on. */
export const recordError = (error: unknown) => {
    recordDiagnostic('error', messageOf(error))
}

if (typeof window !== 'undefined') {
    window.addEventListener('error', (event) => {
        // The browser's note that an observer deferred a notification: not a failure.
        if (event.message.startsWith('ResizeObserver loop')) return
        recordError(event.error ?? event.message)
    })
    window.addEventListener('unhandledrejection', (event) => {
        recordError(event.reason)
    })
}

/** Replaces the home folder in any path with `~`, since paths appear in the apps. */
export const redactPaths = (text: string) =>
    text
        .replace(/[A-Za-z]:[/\\]+Users[/\\]+[^/\\\s"')]+/gi, '~')
        .replace(/(?<![\w.])\/Users\/[^/\s"')]+/g, '~')
        .replace(/(?<![\w.])\/home\/[^/\s"')]+/g, '~')

// Decimal units, as every size the editor shows (Part 1 §1.4.7).
const formatBytes = (bytes: number) => {
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let value = bytes
    let unit = 0
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000
        unit++
    }
    return `${unit === 0 ? value : value.toFixed(1)} ${units[unit] ?? ''}`
}

const storageText = (estimate: DiagnosticFields['estimate']) => {
    const { usage, quota } = estimate ?? {}
    if (usage !== undefined && quota !== undefined)
        return `${formatBytes(usage)} used of about ${formatBytes(quota)}`
    if (usage !== undefined) return `${formatBytes(usage)} used, quota unknown`
    if (quota !== undefined) return `about ${formatBytes(quota)} available, usage unknown`
    return 'unavailable'
}

/** What storing says about itself (Part 1 §1.4.16); absent in a tab that never started it. */
export type StoringFields = {
    /** Absent before the worker answered. */
    mode?: 'stored' | 'readOnly' | 'memory'
    /** Why storing is paused, or why it runs in memory. */
    reason?: string
    /** How many times this tab restarted the storage worker. */
    restarts: number
    /** Absent when the database could not be read. */
    database?: { version: number; format?: number; sessions: number; chains: number }
}

const storingText = (storing: StoringFields) => {
    const { mode, reason } = storing
    const why = reason ? ` (${reason})` : ''
    return mode === undefined
        ? 'not started'
        : mode === 'stored'
          ? reason
              ? `paused${why}`
              : 'on'
          : mode === 'readOnly'
            ? 'read-only'
            : `off, in memory only${why}`
}

export type DiagnosticFields = {
    productName: string
    appVersion: string
    atTag: boolean
    /** Whether the version names a commit after the release (`X.Y.Z+hash`). */
    hasCommit: boolean
    site: string
    engine: string
    os: string
    standalone: boolean
    userAgent: string
    estimate?: { usage?: number; quota?: number }
    storing?: StoringFields
    entries: readonly RingEntry[]
}

const storingLines = (storing: StoringFields | undefined) => {
    if (!storing) return []
    const { database } = storing
    return [
        `Database: ${
            database
                ? `version ${database.version}${database.format === undefined ? '' : `, format ${database.format}`}`
                : 'unavailable'
        }`,
        `Storing: ${storingText(storing)}`,
        `Worker restarts: ${storing.restarts}`,
        `Sessions: ${database ? `${database.sessions}, chains: ${database.chains}` : 'unavailable'}`,
    ]
}

/** The plain text for a bug report; English, whatever the editor's language. */
export const formatDiagnostics = (fields: DiagnosticFields) => {
    const { estimate } = fields
    const lines = [
        `${fields.productName} ${fields.appVersion}`,
        `Build: ${fields.atTag ? 'release' : fields.hasCommit ? 'between releases' : 'untagged'}${fields.site === 'test' ? ', test site' : ''}`,
        `Engine: ${fields.engine}`,
        `OS: ${fields.os}`,
        `Standalone: ${fields.standalone ? 'yes' : 'no'}`,
        `Storage: ${storageText(estimate)}`,
        ...storingLines(fields.storing),
        `User agent: ${fields.userAgent}`,
        '',
        `Last ${RING_SIZE} errors and CSP violations: ${fields.entries.length ? '' : 'none'}`.trimEnd(),
    ]
    for (const entry of fields.entries)
        lines.push(`- ${new Date(entry.at).toISOString()} ${entry.kind}: ${entry.text}`)
    return redactPaths(lines.join('\n'))
}
