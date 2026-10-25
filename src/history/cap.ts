/**
 * The undo stack's most slots, in the tab and in the stored window [WS-31]. Steps before them
 * stay in History's Timeline. Readers take a stored or file stack of any length and cut it.
 */
export const STACK_CAP = 1000

/**
 * The slots kept from a stack of `length` slots, as a `base` and a kept `length`: normally
 * the newest `STACK_CAP`; when the index sits below them, the redo end is cut first, so they are
 * the `STACK_CAP` slots ending at the index, or starting at slot 0 when the index is under the
 * cap. Slots below `floor` (a restored stack's own base) aren't known, so the span never starts
 * below it.
 */
export const cappedSpan = (length: number, index: number, floor = 0) => {
    if (!(index >= floor && index < length)) throw new RangeError('The index is outside the stack')
    let base = Math.max(floor, length - STACK_CAP)
    if (index < base) base = Math.max(floor, index < STACK_CAP ? 0 : index - STACK_CAP + 1)
    return { base, length: Math.min(STACK_CAP, length - base) }
}
