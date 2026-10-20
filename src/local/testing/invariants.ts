import { DB_NAME } from '../db'
import { keyText } from '../kv/keys'
import type { MemoryKv } from '../kv/memory'
import type { Key } from '../kv/types'
import {
    stackViolations,
    type ReplayEntry,
    type SessionRows,
    type StackBlockRow,
} from '../timeline'

// The stored-data invariants the crash sweep checks after every kill (§1.6.1): no dangling
// `refs` or hash, no half-deleted chain, every row reachable from its parent. Step 3b adds the
// stored stack equal to replay; later steps add theirs.

type Rows = Map<string, { key: Key; value: unknown }[]>

const record = (value: unknown) => (value ?? {}) as Record<string, unknown>

const packed = (bytes: unknown): Uint8Array[] => {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength % 16) return []
    const out: Uint8Array[] = []
    for (let at = 0; at < bytes.byteLength; at += 16) out.push(bytes.subarray(at, at + 16))
    return out
}

const hex = (bytes: Uint8Array) => keyText(bytes)

/** Each stored stack is a window of what its entries replay to (§1.3.9). */
export const replayViolations = (rows: Rows): string[] => {
    const all = (store: string) => rows.get(store) ?? []
    const id = (key: Key) => (typeof key === 'string' ? key : keyText(key))
    const sessions = new Map(all('sessions').map((row) => [id(row.key), record(row.value)]))
    const bySession = new Map<string, SessionRows & { entries: ReplayEntry[] }>()
    for (const [id, session] of sessions)
        bySession.set(id, { session, entries: [], blocks: new Map() })
    for (const row of all('entries')) {
        const entry = record(row.value)
        bySession.get(String(entry.sessionId))?.entries.push(entry as unknown as ReplayEntry)
    }
    for (const row of all('stackBlocks')) {
        const block = record(row.value) as unknown as StackBlockRow
        const blocks = bySession.get(block.sessionId)?.blocks as
            Map<number, StackBlockRow> | undefined
        blocks?.set(block.block, block)
    }
    for (const rows of bySession.values()) rows.entries.sort((a, b) => a.seq - b.seq)
    // Replay can't follow a session whose ancestor was deleted: its stack is not checked.
    const followable = (id: string): boolean => {
        const parent = record(bySession.get(id)?.session.parent)
        return typeof parent.id !== 'string' || (bySession.has(parent.id) && followable(parent.id))
    }
    for (const id of [...bySession.keys()]) if (!followable(id)) bySession.delete(id)
    return stackViolations(bySession)
}

/** Every violation in a dump of `nse-local-data`; empty when the data is whole. */
export const storedViolations = (rows: Rows): string[] => {
    const violations: string[] = []
    const all = (store: string) => rows.get(store) ?? []
    const hashes = new Set<string>()
    for (const store of ['nodes', 'chunks', 'media'])
        for (const row of all(store)) hashes.add(keyText(row.key))
    const has = (hash: Uint8Array) => hashes.has(hex(hash))

    const id = (key: Key) => (typeof key === 'string' ? key : keyText(key))
    const chains = new Map(all('chains').map((row) => [id(row.key), record(row.value)]))
    const sessions = new Map(all('sessions').map((row) => [id(row.key), record(row.value)]))

    for (const [chainId, chain] of chains) {
        const head = sessions.get(String(chain.head))
        if (!head) violations.push(`chain ${chainId}: head ${String(chain.head)} is missing`)
        else if (head.chainId !== chainId)
            violations.push(`chain ${chainId}: head belongs to ${String(head.chainId)}`)
    }
    for (const [id, session] of sessions)
        if (!chains.has(String(session.chainId)))
            violations.push(`session ${id}: chain ${String(session.chainId)} is missing`)
    // A stored handle belongs to a chain field that exists (D24): deleting a chain deletes them.
    for (const row of all('handles')) {
        const handle = record(row.value)
        const field = chains.get(String(handle.chainId))?.[String(handle.role)]
        if (field === undefined)
            violations.push(`handle ${keyText(row.key)}: its chain field is missing`)
        else if ('handle' in record(field))
            violations.push(`handle ${keyText(row.key)}: its chain record holds a handle too`)
    }
    for (const row of all('entries')) {
        const entry = record(row.value)
        if (!sessions.has(String(entry.sessionId)))
            violations.push(`entry ${keyText(row.key)}: session is missing`)
        if (entry.kept !== false && entry.snapshot instanceof Uint8Array && !has(entry.snapshot))
            violations.push(`entry ${keyText(row.key)}: snapshot ${hex(entry.snapshot)} is missing`)
    }
    for (const row of all('stackBlocks')) {
        const block = record(row.value)
        if (!sessions.has(String(block.sessionId)))
            violations.push(`stack block ${keyText(row.key)}: session is missing`)
        for (const hash of packed(block.hashes))
            if (!has(hash))
                violations.push(`stack block ${keyText(row.key)}: ${hex(hash)} is missing`)
    }
    violations.push(...replayViolations(rows))
    violations.push(...sessionViolations(rows))
    for (const row of all('tombstones')) {
        const tombstone = record(row.value)
        if (!chains.has(String(tombstone.chainId)))
            violations.push(`tombstone ${keyText(row.key)}: chain is missing`)
    }
    for (const row of all('nodes')) {
        const node = record(row.value)
        let refs = packed(node.refs)
        // A root's media may be absent: a state records its BGM whether or not it's held (§1.6.8.4).
        if (node.t === 'root' && Array.isArray(node.kinds))
            refs = refs.slice(0, 1 + node.kinds.length)
        for (const hash of refs)
            if (!has(hash)) violations.push(`node ${keyText(row.key)}: ref ${hex(hash)} is missing`)
    }
    return violations
}

const seqList = (seqs: readonly number[]) => seqs.join(', ')

export type SessionOptions = {
    /** Check every time against `meta.maxSeenTime` (default); false for data a fixture wrote. */
    maxSeenTime?: boolean
    /** A `seq` the test knows was let go: a hole the plan allows. */
    hole?: (sessionId: string, seq: number) => boolean
}

/**
 * The invariants of a session's rows (architecture review §A, R-A1 and R-A2), each naming the rows
 * that break it. They hold because one writer stores a session's rows in `seq` order:
 * - `lastSeq` is the high-water mark: no stored row lies above it;
 * - every `seq` up to `lastSeq` is stored, covered by a `recovered` row above it, the binding's
 *   own Save row (a kept gap the file may hold), a hole the test says it let go (`hole`: a
 *   released reservation under later rows), or, only while `importPending`, a row to come;
 * - `time` never decreases in `seq` within a session, and `maxSeenTime` reaches every row's (not
 *   checked for sessions of origin `nxsp` or `replaced`: they hold a file's rows with its times);
 * - a session a continuation branched from holds no row past its `uptoSeq`;
 * - `entryCount` is the number of stored rows;
 * - an entry's key is its own `sessionId` and `seq`.
 * The stored stack equal to replay is `stackViolations`'.
 */
export const sessionViolations = (
    rows: Rows,
    { maxSeenTime = true, hole }: SessionOptions = {},
): string[] => {
    const violations: string[] = []
    const all = (store: string) => rows.get(store) ?? []
    const id = (key: Key) => (typeof key === 'string' ? key : keyText(key))
    const sessions = new Map(all('sessions').map((row) => [id(row.key), record(row.value)]))
    const chains = new Map(all('chains').map((row) => [id(row.key), record(row.value)]))
    const maxSeen = !maxSeenTime
        ? undefined
        : all('meta')
              .map((row) => record(row.value))
              .find((row) => row.key === 'maxSeenTime')?.value
    const stored = new Map<string, Record<string, unknown>[]>()
    for (const row of all('entries')) {
        const entry = record(row.value)
        const key = row.key
        if (Array.isArray(key) && (key[0] !== entry.sessionId || key[1] !== entry.seq))
            violations.push(
                `entry ${keyText(key)}: its row says session ${String(entry.sessionId)} seq ${String(entry.seq)}`,
            )
        const list = stored.get(String(entry.sessionId)) ?? []
        list.push(entry)
        stored.set(String(entry.sessionId), list)
    }
    for (const list of stored.values()) list.sort((a, b) => Number(a.seq) - Number(b.seq))
    for (const [sessionId, session] of sessions) {
        const entries = stored.get(sessionId) ?? []
        const lastSeq = typeof session.lastSeq === 'number' ? session.lastSeq : 0
        const pending = session.importPending === true
        const seqs = new Set(entries.map((entry) => Number(entry.seq)))
        const above = [...seqs].filter((seq) => seq > lastSeq)
        if (above.length)
            violations.push(
                `session ${sessionId}: rows ${seqList(above)} lie above lastSeq ${String(lastSeq)}`,
            )
        const own = record(record(chains.get(String(session.chainId))?.file).entry)
        const recoveredAt = entries
            .filter((entry) => entry.kind === 'recovered')
            .map((entry) => Number(entry.seq))
        const holes: number[] = []
        for (let seq = 1; seq <= lastSeq; seq++) {
            if (seqs.has(seq) || pending) continue
            if (recoveredAt.some((at) => at > seq && at <= lastSeq)) continue
            if (own.sessionId === sessionId && own.seq === seq) continue
            if (hole?.(sessionId, seq)) continue
            holes.push(seq)
        }
        if (holes.length)
            violations.push(
                `session ${sessionId}: rows ${seqList(holes)} up to lastSeq ${String(lastSeq)} are neither stored, covered by a recovered row, nor the binding’s own Save`,
            )
        // A session opened from a file holds the file’s rows with their own times, which this
        // editor did not stamp: only a session’s own rows are strictly increasing, and until an
        // `importedRows` marker says which are the file’s, nxsp and replaced sessions are skipped.
        const filed = session.origin === 'nxsp' || session.origin === 'replaced'
        for (let at = 1; at < entries.length && !filed; at++) {
            const before = record(entries[at - 1])
            const after = record(entries[at])
            if (
                typeof before.time === 'number' &&
                typeof after.time === 'number' &&
                before.time > after.time
            )
                violations.push(
                    `session ${sessionId}: row ${String(before.seq)} (time ${before.time}) is later than row ${String(after.seq)} (time ${after.time})`,
                )
        }
        if (typeof maxSeen === 'number' && !filed) {
            const beyond = entries.filter(
                (entry) => typeof entry.time === 'number' && entry.time > maxSeen,
            )
            if (beyond.length)
                violations.push(
                    `session ${sessionId}: rows ${seqList(beyond.map((entry) => Number(entry.seq)))} have a time past maxSeenTime ${String(maxSeen)}`,
                )
        }
        const parent = record(session.parent)
        if (typeof parent.id === 'string' && typeof parent.uptoSeq === 'number') {
            const from = sessions.get(parent.id)
            if (from) {
                const past = (stored.get(parent.id) ?? [])
                    .map((entry) => Number(entry.seq))
                    .filter((seq) => seq > (parent.uptoSeq as number))
                if (past.length)
                    violations.push(
                        `session ${sessionId}: parent ${parent.id} holds rows ${seqList(past)} past its uptoSeq ${String(parent.uptoSeq)}`,
                    )
                if (typeof from.lastSeq === 'number' && from.lastSeq !== parent.uptoSeq)
                    violations.push(
                        `session ${sessionId}: parent ${parent.id} has lastSeq ${String(from.lastSeq)}, not its uptoSeq ${String(parent.uptoSeq)}`,
                    )
            }
        }
        if (
            !pending &&
            typeof session.entryCount === 'number' &&
            session.entryCount !== entries.length
        )
            violations.push(
                `session ${sessionId}: entryCount ${session.entryCount} but ${entries.length} rows are stored`,
            )
    }
    return violations
}

/**
 * Sessions with rows but no stored stack (AR-3): replay rebuilds it, so this is the degraded path,
 * not damage. A late writer's net removes it; a late flush past a replayed journal drops it by
 * design (§1.6.6), and a hand-built fixture may never have written one. So `checkStored` leaves it
 * out, and a test asks for it where no writer should have removed one.
 */
export const missingStackViolations = (rows: Rows): string[] => {
    const entries = new Set(
        (rows.get('entries') ?? []).map((row) => String(record(row.value).sessionId)),
    )
    return (rows.get('sessions') ?? [])
        .filter((row) => {
            const session = record(row.value)
            return (
                session.importPending !== true &&
                session.stack === undefined &&
                entries.has(String(session.id))
            )
        })
        .map(
            (row) =>
                `session ${String(record(row.value).id)}: its stored stack is missing (replay rebuilds it)`,
        )
}

/** The violations in the memory store's `nse-local-data`. */
export const checkStored = (memory: MemoryKv) => storedViolations(memory.dump(DB_NAME))

/**
 * `checkStored` and the sessions with rows but no stored stack: for a run whose writers all hold
 * their session's lock in order, where nothing should have removed one (AR-3).
 */
export const checkStrict = (memory: MemoryKv) => {
    const dump = memory.dump(DB_NAME)
    return [...storedViolations(dump), ...missingStackViolations(dump)]
}

/**
 * The invariants of a session's rows alone, for a run whose data has chunks or snapshots gone on
 * purpose: `sessionViolations`, the stored stack equal to its replay, and no stack missing.
 * `maxSeenTime: false` for data a fixture wrote without the time meta.
 */
export const sessionChecks = (memory: MemoryKv, options: SessionOptions = {}) => {
    const dump = memory.dump(DB_NAME)
    return [
        ...sessionViolations(dump, options),
        ...replayViolations(dump),
        ...missingStackViolations(dump),
    ]
}
