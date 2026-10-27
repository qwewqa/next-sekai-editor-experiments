// What the web reads of a chain's data kept elsewhere:
// whether its work is in a file.

/** What a stored chain says of its file: the facts `notSavedToFile` reads. */
export type SavedFacts = {
    /** The chain has a bound file. */
    bound: boolean
    /** The head's state differs from the file event's; false without a file. */
    changed: boolean
    /** The chain holds work: edited, or opened from a file. */
    hasContent: boolean
    /** `newer` or `damaged`: this build can't read the chain, so what the file holds is unknown. */
    readable?: 'yes' | 'newer' | 'damaged'
}

/**
 * Whether a stored chain has work no file holds: bound and changed since its file event, or
 * unbound with content. A download counts as the file. The stored-chain twin of
 * `hasEditsNotInFile` (`editor/file/closePrompt.ts`). A chain this build can't read counts as
 * not saved.
 */
export const notSavedToFile = (facts: SavedFacts) => {
    if (facts.readable === 'newer' || facts.readable === 'damaged') return true
    return facts.bound ? facts.changed : facts.hasContent
}
