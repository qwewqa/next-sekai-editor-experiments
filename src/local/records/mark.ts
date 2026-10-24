import { toHex } from '../hash'
import { unpackHashes } from './rows'

/** A `nodes` row this build can't mark through: GC aborts, as for an unknown `v`. */
export class UnknownNodeError extends Error {
    override name = 'UnknownNodeError'
}

/** What marking needs of a `nodes` row: its type and its direct children. */
export type MarkRow = { t?: unknown; refs?: unknown }

/**
 * GC's marking: everything reachable from `roots` through `nodes` rows' `refs`,
 * transitively. A hash with no `nodes` row is a chunk or a media item, a leaf. Returns the
 * reached hashes as hex, the roots included. Throws `UnknownNodeError` on a row it can't read.
 */
export const markReachable = async (
    roots: Iterable<Uint8Array>,
    getNode: (hash: Uint8Array) => MarkRow | undefined | Promise<MarkRow | undefined>,
): Promise<Set<string>> => {
    const marked = new Set<string>()
    const pending = [...roots]
    for (let hash = pending.pop(); hash; hash = pending.pop()) {
        const key = toHex(hash)
        if (marked.has(key)) continue
        marked.add(key)
        const row = await getNode(hash)
        if (!row) continue
        if ((row.t !== 'root' && row.t !== 'node') || !(row.refs instanceof Uint8Array))
            throw new UnknownNodeError(`Unexpected nodes row ${key}`)
        pending.push(...unpackHashes(row.refs))
    }
    return marked
}
