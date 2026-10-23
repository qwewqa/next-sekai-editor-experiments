import { DB_NAME, STORE_NAMES } from '../db'
import { keyText } from '../kv/keys'
import type { CommitReport } from '../kv/memory'
import type { Key } from '../kv/types'

// The transition check and the lock-holder assertion of architecture review A (A0+; spec A's
// I-1 to I-5 and I-4's binding rule, work/arch/spec-A.md): what each committed read-write transaction of the
// profile's database may do to a session's rows. The memory store reports a commit with the rows
// it put (as they were before) and removed; the world adds the session locks the creating page
// held when the transaction was created. Pure functions over those reports, so a test can feed
// them a made-up commit.

/** What `MemoryObserver.created` returns for a transaction: the session locks its page holds. */
export type CreationContext = {
    /** Sessions whose `nse-session:` lock the page held exclusively at creation. */
    readonly sessions: ReadonlySet<string>
}

export type TransitionChecks = {
    /** I-1: the creating page held the session's lock. */
    lock?: boolean
    /** I-2, I-4, I-5: where rows go and what a frozen session may change. */
    transitions?: boolean
}

type Row = Record<string, unknown>

const record = (value: unknown): Row => (value ?? {}) as Row

const keyId = (key: Key) => (typeof key === 'string' ? key : keyText(key))

/** Deep equality for stored values: plain data, arrays and byte arrays. */
const same = (a: unknown, b: unknown): boolean => {
    if (a === b) return true
    if (a instanceof Uint8Array && b instanceof Uint8Array)
        return a.byteLength === b.byteLength && a.every((byte, at) => byte === b[at])
    if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
    if (Array.isArray(a) !== Array.isArray(b)) return false
    const x = a as Row
    const y = b as Row
    const keys = new Set([...Object.keys(x), ...Object.keys(y)])
    for (const key of keys) if (!same(x[key], y[key])) return false
    return true
}

/** A store's fields that differ between two rows. */
const changed = (before: Row, after: Row, fields: readonly string[]) =>
    fields.filter((field) => !same(before[field], after[field]))

const FILE_ORIGINS = ['nxsp', 'replaced']

/** The session rows an import writes while `importPending` (I-1 (c), I-5): a file's, not the page's. */
const importing = (before: Row | undefined, after: Row | undefined) =>
    [before, after].some(
        (session) =>
            session?.importPending === true && FILE_ORIGINS.includes(String(session.origin)),
    )

/**
 * The violations a committed transaction makes, empty when it keeps the rules. Exempt: the
 * whole-store copy of Try Again (`copyIntoStorage`, the only read-write transaction over every
 * store, which a guard test lists), and whatever is not the profile's database.
 *
 * An opened session while its import is pending: only the import's fill is exempt, the rows at or
 * below `openBase` (the last `seq` of the file's rows, recorded by the open's own transaction) and
 * its fields (`entryCount`, `importPending`). The page's own rows above it, edits
 * flushed during the import, keep every rule. Without a base, every row of such a session counts as
 * the fill.
 */
export const transitionViolations = (
    report: CommitReport,
    checks: TransitionChecks = {},
    openBase?: ReadonlyMap<string, number>,
): string[] => {
    const { lock = true, transitions = true } = checks
    if (report.db !== DB_NAME) return []
    if (STORE_NAMES.every((name) => report.stores.includes(name))) return []
    const violations: string[] = []
    const putsOf = (store: string) => report.puts.filter((put) => put.store === store)
    /** The row as it was before this transaction: the put's `old`, else the stored one. */
    const before = (store: string, key: Key) => {
        const put = report.puts.find(
            (each) => each.store === store && keyId(each.key) === keyId(key),
        )
        return put ? (put.old as Row | undefined) : (report.current(store, key) as Row | undefined)
    }
    const context = (report.context ?? { sessions: new Set<string>() }) as CreationContext

    const created = new Map<string, number[]>()
    for (const put of putsOf('entries')) {
        if (put.old !== undefined) continue
        const { sessionId, seq } = record(put.value)
        const list = created.get(String(sessionId)) ?? []
        list.push(Number(seq))
        created.set(String(sessionId), list)
    }

    const touched = new Set<string>(created.keys())
    for (const put of [...putsOf('sessions')]) touched.add(keyId(put.key))
    for (const put of putsOf('stackBlocks')) touched.add(String(record(put.value).sessionId))
    for (const put of putsOf('entries')) touched.add(String(record(put.value).sessionId))

    for (const sessionId of touched) {
        const was = before('sessions', sessionId)
        const now = report.current('sessions', sessionId) as Row | undefined
        const born = was === undefined
        const filling = importing(was, now)
        const base = openBase?.get(sessionId)
        const made = (created.get(sessionId) ?? []).sort((a, b) => a - b)
        // The rows the page wrote itself: all of them, but an import's fill of an opened session.
        const seqs =
            filling && base === undefined
                ? []
                : made.filter((seq) => !filling || (base !== undefined && seq > base))
        if (lock && seqs.length && !(context.sessions.has(sessionId) || born))
            violations.push(
                `lock: rows ${seqs.join(', ')} of session ${sessionId} were created while the page did not hold nse-session:${sessionId} exclusively`,
            )
        if (!transitions) continue
        if (seqs.length) {
            const lastSeq = typeof was?.lastSeq === 'number' ? was.lastSeq : 0
            const low = seqs.filter((seq) => seq <= lastSeq)
            if (low.length)
                violations.push(
                    `transition: rows ${low.join(', ')} of session ${sessionId} were created at or below its lastSeq ${lastSeq}`,
                )
            const after = typeof now?.lastSeq === 'number' ? now.lastSeq : undefined
            if (after !== seqs.at(-1))
                violations.push(
                    `transition: session ${sessionId} has lastSeq ${String(after)} after creating rows up to ${String(seqs.at(-1))}`,
                )
        }
        // I-5: once not its chain's head, a session's rows and summary change only by `kept`
        // flips and its import's own fill.
        if (!was) continue
        const chain = before('chains', String(was.chainId))
        if (!chain || chain.head === sessionId) continue
        if (seqs.length)
            violations.push(
                `transition: session ${sessionId} is no longer its chain's head, yet rows ${seqs.join(', ')} were created in it`,
            )
        for (const put of putsOf('entries')) {
            const value = record(put.value)
            if (value.sessionId !== sessionId || put.old === undefined) continue
            const differs = changed(record(put.old), value, [
                ...new Set([...Object.keys(record(put.old)), ...Object.keys(value)]),
            ]).filter((field) => field !== 'kept')
            if (differs.length)
                violations.push(
                    `transition: row ${String(value.seq)} of session ${sessionId}, no longer its chain's head, changed ${differs.join(', ')}`,
                )
        }
        for (const put of putsOf('stackBlocks'))
            if (record(put.value).sessionId === sessionId)
                violations.push(
                    `transition: stack block ${String(record(put.value).block)} of session ${sessionId}, no longer its chain's head, was written`,
                )
        if (now) {
            const differs = changed(was, now, [
                'lastSeq',
                'stack',
                'updatedAt',
                ...(filling ? [] : ['entryCount']),
            ])
            if (differs.length)
                violations.push(
                    `transition: session ${sessionId}, no longer its chain's head, changed ${differs.join(', ')}`,
                )
        }
    }

    // A row removed while its session stays (a whole-session delete takes the session row too).
    if (transitions)
        for (const gone of report.deletes)
            for (const { key, value } of gone.rows) {
                if (gone.store !== 'entries' && gone.store !== 'stackBlocks') continue
                const sessionId = String(record(value).sessionId)
                if (!report.current('sessions', sessionId)) continue
                const was = before('sessions', sessionId)
                const chain = was && before('chains', String(was.chainId))
                // A head's stack blocks are rewritten, and so removed, as its window moves.
                if (gone.store === 'stackBlocks' && (!chain || chain.head === sessionId)) continue
                violations.push(
                    `transition: ${gone.store === 'entries' ? 'row' : 'stack block'} ${keyId(key)} of session ${sessionId} was removed while the session stays`,
                )
            }

    // R3: a session is removed only by a page holding its lock exclusively.
    if (lock)
        for (const gone of report.deletes) {
            if (gone.store !== 'sessions') continue
            for (const { key } of gone.rows)
                if (!context.sessions.has(keyId(key)))
                    violations.push(
                        `lock: session ${keyId(key)} was removed while the page did not hold nse-session:${keyId(key)} exclusively`,
                    )
        }

    // I-4: a chain's binding is recorded only while none of its sessions is importing.
    if (transitions)
        for (const put of putsOf('chains')) {
            if (put.old === undefined) continue
            const was = record(put.old)
            const now = record(put.value)
            if (!changed(was, now, ['docId', 'revision', 'file']).length) continue
            const chainId = keyId(put.key)
            const filling = report
                .rows('sessions')
                .map((row) => record(row.value))
                .filter((session) => session.chainId === chainId && session.importPending === true)
            if (filling.length)
                violations.push(
                    `transition: chain ${chainId} recorded a binding while session ${filling.map((session) => String(session.id)).join(', ')} was importing`,
                )
        }
    return violations
}
