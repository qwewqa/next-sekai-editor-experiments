import { captureOperation, captureStep, type JsonValue } from '../../history/operations'
import { countDayOfUse } from '../days'
import { hashKey, readMeta, writeMeta } from '../db'
import { FLUSH_STORES, type PreparedFlush } from '../flushWrite'
import type { KvTx } from '../kv/types'
import { putChunk } from '../putChunk'
import { nodeRow, rootRow } from '../records/rows'
import { SESSION_V } from '../records/version'
import type { StateBatch } from '../stateBatch'
import { nextTime } from '../time'
import { blockRow, chainFlagsAtCreation } from '../timeline'

// The auto save migration's transaction (Part 1 §1.8), in the storage worker: the old slot
// becomes a session, a new chain with one `init` entry, stored at once and strictly, unless
// `meta.migratedHashes` already holds its hash, so the same slot read twice, or written back by
// an old tab, never makes a second session, and one migrated before never comes back.

export type MigrationBatch = StateBatch & {
    /** The SHA-256 of the slot's raw text (its UTF-8 bytes), as hex. */
    hash: string
    ids: { chainId: string; docId: string; lineageId: string; sessionId: string }
    /** The slot's file name, as the import rule names it (§1.3.5). */
    sourceName?: string
    /** The `init` entry's label: "Recovered from auto save". */
    operation: JsonValue
    appVersion: string
    wall: number
}

export type MigrationResult =
    | { kind: 'migrated'; sessionId: string; chainId: string }
    /** Migrated before: nothing is written. */
    | { kind: 'duplicate' }

export const MIGRATION_STORES = FLUSH_STORES

export const writeMigration = async (
    tx: KvTx,
    batch: MigrationBatch,
    prepared: PreparedFlush,
): Promise<MigrationResult> => {
    const migrated = (await readMeta(tx, 'migratedHashes')) ?? []
    if (migrated.includes(batch.hash)) return { kind: 'duplicate' }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const root = prepared.roots[0]!
    const nodes = []
    for (const node of [...prepared.nodes, root])
        if ((await tx.getKey('nodes', hashKey(node.hash))) === undefined) nodes.push(node)

    // Writes.
    let maxSeen = (await readMeta(tx, 'maxSeenTime')) ?? 0
    const time = (maxSeen = nextTime(maxSeen, batch.wall))
    const day = await countDayOfUse(tx, time)
    for (const chunk of prepared.chunks) await putChunk(tx, chunk, day)
    for (const node of nodes) {
        const row = node === root ? rootRow(root, day) : nodeRow(node as never, day)
        await tx.put('nodes', row, hashKey(node.hash))
    }
    const { chainId, docId, lineageId, sessionId } = batch.ids
    const snapshot = root.hash.slice()
    const operation = captureOperation(batch.operation)
    const step = captureStep({ kind: 'init', operation })
    await tx.put('chains', {
        chainId,
        head: sessionId,
        docId,
        lineageId,
        // The import rule (§1.3.5): no Name, the slot's file name as the source's.
        ...(batch.sourceName === undefined ? {} : { sourceName: batch.sourceName }),
        // Its work is in no file: edited from its first entry (§1.4.9).
        ...chainFlagsAtCreation('migrated'),
        startedAt: time,
        updatedAt: time,
        day,
        summary: batch.summary,
        appVersion: batch.appVersion,
    })
    await tx.put('sessions', {
        id: sessionId,
        v: SESSION_V,
        chainId,
        startedAt: time,
        updatedAt: time,
        day,
        origin: 'migrated',
        stack: { base: 0, length: 1, index: 0 },
        lastSeq: 1,
        entryCount: 1,
        activeMs: 0,
        appVersion: batch.appVersion,
    })
    await tx.put('entries', {
        sessionId,
        seq: 1,
        time,
        day,
        kind: 'init',
        operation,
        snapshot,
        noteCount: root.noteCount,
        dirty: true,
        kept: true,
    })
    await tx.put('stackBlocks', blockRow(sessionId, 0, 0, [{ snapshot, step }]))
    await writeMeta(tx, 'migratedHashes', [...migrated, batch.hash])
    await writeMeta(tx, 'maxSeenTime', maxSeen)
    return { kind: 'migrated', sessionId, chainId }
}
