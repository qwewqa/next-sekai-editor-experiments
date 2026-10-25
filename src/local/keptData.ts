// What the web reads of a chain's data kept elsewhere:
// whether its work is in a file.

/** What a stored chain says of its file: the facts `notSavedToFile` reads. */
export type SavedFacts = {
    /** The chain's binding as stored; an unknown `event` reads as a download (`fileEvent`). */
    file?: { event?: string; confirmed?: boolean }
    /** The head's state differs from the file event's; false without a file. */
    changed: boolean
    /** The chain holds work: edited, or opened from a file. */
    hasContent: boolean
    /** `newer` or `damaged`: this build can't read the chain, so what the file holds is unknown. */
    readable?: 'yes' | 'newer' | 'damaged'
}

/**
 * Whether a stored chain has work no file holds: bound and changed since its file event, bound by
 * a download that isn't confirmed, or unbound with content. The stored-chain twin of
 * `hasChangesNotInFile` (`editor/file/closePrompt.ts`). A chain this build can't read counts as
 * not saved. `downloadConfirmedHere` is this browser's answer for downloads: true when this
 * browser confirms downloads.
 */
export const notSavedToFile = (facts: SavedFacts, downloadConfirmedHere: boolean) => {
    if (facts.readable === 'newer' || facts.readable === 'damaged') return true
    const file = facts.file
    if (!file) return facts.hasContent
    if (facts.changed) return true
    const downloaded = file.event !== 'saved' && file.event !== 'opened'
    return downloaded && file.confirmed !== true && !downloadConfirmedHere
}
