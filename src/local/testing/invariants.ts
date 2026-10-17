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
    // Each stored stack is a window of what its entries replay to (§1.3.9).
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
    violations.push(...stackViolations(bySession))
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

/** The violations in the memory store's `nse-local-data`. */
export const checkStored = (memory: MemoryKv) => storedViolations(memory.dump(DB_NAME))
