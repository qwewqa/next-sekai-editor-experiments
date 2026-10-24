import { sameContent } from '../../platform/fingerprint'
import type { DiskState } from '../../platform/types'

// Open of the file the open session's chain last wrote: when the file is that
// write, unchanged on both sides, Open makes no new chain and keeps the session. Each fact is read
// by the page; a read that fails gives the fact that does not match, so the open goes on as any
// other open does.

export type ReopenFacts = {
    /** The open is whole and in this tab only. */
    identity: boolean
    /** The file's level is its history's head. */
    asHead: boolean
    /** The opened file: `project.json`'s `id` and revision, its history's head (hex), its disk. */
    file: { docId?: string; revisionId?: string; head?: string; disk?: DiskState; handle: boolean }
    /** The open session's binding, read again as a Save reads it; undefined when the read failed. */
    binding:
        | {
              docId: string
              revisionId?: string
              replaced: boolean
              file?: { event: string; hash: string; disk?: DiskState; handle: boolean }
          }
        | undefined
    /** The live state differs from the binding's (or the label names another state). */
    changed: boolean
    /** Both handles name one file; only asked when both exist. */
    sameEntry: boolean
    /** The chain has chunks found bad; true when that could not be read. */
    badChunks: boolean
    /** Every media hash the live state names is held in this tab or in storage. */
    mediaHeld: boolean
}

/**
 * Whether the opened file is the open session's own last write: the same `docId`, revision and
 * head, a binding this chain wrote (an open's binding may lack rows the file holds), nothing
 * changed since, the same file where both sides have a handle (none where neither has: `docId`,
 * revision and head identify the write), and nothing a fresh import would repair.
 */
export const reopensOwnFile = (facts: ReopenFacts) => {
    const { file, binding } = facts
    const bound = binding?.file
    if (!facts.identity || !facts.asHead || !binding || !bound || binding.replaced) return false
    if (bound.event === 'opened') return false
    if (file.docId === undefined || file.docId !== binding.docId) return false
    if (file.revisionId === undefined || file.revisionId !== binding.revisionId) return false
    if (file.head === undefined || file.head !== bound.hash || facts.changed) return false
    if (file.handle !== bound.handle) return false
    if (
        file.handle &&
        !(facts.sameEntry && file.disk && bound.disk && sameContent(file.disk, bound.disk))
    )
        return false
    return !facts.badChunks && facts.mediaHeld
}
