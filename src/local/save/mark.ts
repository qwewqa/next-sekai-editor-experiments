import { equalBytes, fromHex16 } from '../hash'
import { packHashes, unpackHashes } from '../records/rows'
import type { SaveStore } from './bodies'
import type { EntryRow } from './cut'

// Damage a build found in storage, or Check File and History left after its
// repair: the rows whose states need a body that's missing or fails are marked
// `kept: false` (one-way), and its hash goes into the chain's `badChunks` for History's "damaged"
// label (display only, never shrunk). Field-level read-modify-writes in one transaction; a failure
// leaves storing as it was, and a write goes on with those rows `kept: false` in its file anyway.

/** Marks rows and records hashes; resolves how many rows it newly marked, undefined when not stored. */
export const markDamaged = async (
    store: SaveStore,
    chainId: string,
    rows: readonly Pick<EntryRow, 'sessionId' | 'seq'>[],
    hashes: readonly string[],
): Promise<number | undefined> => {
    console.error('Damage in storage found', { chainId, rows: rows.length, hashes })
    try {
        return await store.write(
            ['entries', 'chains'],
            async (tx) => {
                let marked = 0
                for (const row of rows) {
                    const stored = (await tx.get('entries', [row.sessionId, row.seq])) as
                        Record<string, unknown> | undefined
                    if (stored && stored.kept !== false) {
                        await tx.put('entries', { ...stored, kept: false })
                        marked++
                    }
                }
                if (!hashes.length) return marked
                const chain = (await tx.get('chains', chainId)) as
                    Record<string, unknown> | undefined
                if (!chain) return marked
                const known =
                    chain.badChunks instanceof Uint8Array ? unpackHashes(chain.badChunks) : []
                const added = hashes
                    .map(fromHex16)
                    .filter((hash) => !known.some((each) => equalBytes(each, hash)))
                if (added.length)
                    await tx.put('chains', {
                        ...chain,
                        badChunks: packHashes([...known, ...added]),
                    })
                return marked
            },
            { durability: 'strict', pauseOnFailure: false },
        )
    } catch (error) {
        console.error('Marking damage in storage failed', error)
        return undefined
    }
}
