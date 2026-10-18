import { equalBytes, fromHex16 } from '../hash'
import { packHashes, unpackHashes } from '../records/rows'
import type { SaveStore } from './bodies'
import type { EntryRow } from './cut'

// Damage a build found in storage (Part 1 §1.6.11.6): before the plan is final, the rows whose
// states need a body that's missing or fails are marked `kept: false` (one-way), and its hash goes
// into the chain's `badChunks` for History's "damaged" label (display only, never shrunk). Field-level
// read-modify-writes in one transaction; a failure leaves storing as it was, and the write goes on
// with those rows `kept: false` in its file anyway.

/** Marks rows and records hashes; resolves whether the marks were stored. */
export const markDamaged = async (
    store: SaveStore,
    chainId: string,
    rows: readonly EntryRow[],
    hashes: readonly string[],
): Promise<boolean> => {
    console.error('Damage in storage found by a Save', { chainId, rows: rows.length, hashes })
    try {
        await store.write(
            ['entries', 'chains'],
            async (tx) => {
                for (const row of rows) {
                    const stored = (await tx.get('entries', [row.sessionId, row.seq])) as
                        Record<string, unknown> | undefined
                    if (stored && stored.kept !== false)
                        await tx.put('entries', { ...stored, kept: false })
                }
                if (!hashes.length) return
                const chain = (await tx.get('chains', chainId)) as
                    Record<string, unknown> | undefined
                if (!chain) return
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
            },
            { durability: 'strict', pauseOnFailure: false },
        )
        return true
    } catch (error) {
        console.error('Marking damage in storage failed', error)
        return false
    }
}
