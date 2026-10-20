import { bytesOf, sameBytes, startsWith, type World } from './world'

// The six invariants of work/soundness/architecture-review.md §B.6 (I1 to I6), as checks over what
// a world recorded, plus two the task adds: the marker only for a write that may have landed (I7),
// and cancel at any await (I8: nothing written, nothing held).

export type Violation = { invariant: string; detail: string }

/** Dialogs that block on the user, as opposed to a toast: none may show under the lock (I6). */
const MODAL = new Set([
    'saveDialog',
    'conflict',
    'notFound',
    'denied',
    'readOnly',
    'failed',
    'refused',
    'notPutBack',
])

export type Facts = {
    /** Files whose bytes this Save had to keep: the bytes they held at their pick. */
    inHand: (name: string) => boolean
    /** The exit is known not to have written: no marker may stay (I7). */
    unwritten?: boolean
    /** The Save was cancelled before any pick: nothing may be written or held (I8). */
    cancelled?: boolean
    /** A pick of this world's own import-gated state: no picker may open while it runs (I5). */
    expectNoPicker?: boolean
}

const offered = async (world: World, bytes: Uint8Array) => {
    for (const download of world.mock.downloads)
        if (sameBytes((await bytesOf(download.blob))!, bytes)) return true
    return false
}

export const check = async (world: World, facts: Facts): Promise<Violation[]> => {
    const found: Violation[] = []
    const add = (invariant: string, detail: string) => found.push({ invariant, detail })

    // I1: a picked file never ends holding less than it held at its pick while its bytes are in
    // hand; the bytes are put back, appended to, or offered.
    for (const [name, blob] of world.before) {
        if (!blob || blob.size === 0) continue
        const before = (await bytesOf(blob))!
        const now = await bytesOf(world.mock.files.get(name))
        const kept = now !== undefined && startsWith(now, before)
        if (kept || (await offered(world, before))) continue
        if (facts.inHand(name))
            add(
                'I1',
                `${name} held ${before.length} bytes at its pick and ends with ${now?.length ?? 'no file'}; none offered`,
            )
        else if (!now?.length)
            add(
                'info:emptied',
                `${name} held ${before.length} bytes at its pick, not in hand; it ends empty`,
            )
    }

    // I2: a write to a picked file holds `nse-bind` exclusive.
    for (const write of world.writes)
        if (write.picked && !write.exclusive)
            add('I2', `${write.name} written without nse-bind exclusive (shared: ${write.shared})`)

    // I3: every reservation ends exactly once, and none is left held.
    for (const [i, { ends }] of world.reservations.entries())
        if (ends.length !== 1) add('I3', `reservation #${i + 1} ended ${ends.length} times`)
    const reserved = (world.session as { reserved?: number }).reserved
    if (reserved !== undefined) add('I3', `the session still holds reserved seq ${reserved}`)

    // I4: no picker opens on a lapsed activation without a ready press.
    for (const opening of world.openings)
        if (!opening.activation) add('I4', `a picker opened for ${opening.name} without activation`)

    // I5: no picker opens while an import of the session runs or is pending.
    for (const opening of world.openings) {
        if (opening.importing) add('I5', `a picker opened for ${opening.name} during the import`)
        else if (opening.importPending)
            add('I5', `a picker opened for ${opening.name} with the import pending`)
    }

    // I6: "Preparing…" closed at the end; no modal dialog while the lock is held; no lock left.
    for (const entry of world.preparing)
        if (entry.open) add('I6', `the "Preparing ${entry.name}" dialog was left open`)
    for (const dialog of world.dialogs)
        if (MODAL.has(dialog.kind) && dialog.lockHeld)
            add('I6', `the ${dialog.kind} dialog showed while nse-bind was held`)
    if (world.lockHeld()) add('I6', 'nse-bind was still held at the end')

    // I7: a marker stays only for a write that may have landed.
    const marker = localStorage.getItem('sonolus-next-sekai-editor.saving.chain-own')
    if (marker !== null && world.writes.length === 0 && facts.unwritten)
        add('I7', 'a write marker stays though nothing was written')

    // I8: a Save cancelled before its pick wrote nothing, opened no picker, held nothing.
    if (facts.cancelled) {
        if (world.writes.length) add('I8', `a cancelled Save wrote ${world.writes.length} file(s)`)
        if (world.openings.length) add('I8', 'a cancelled Save opened a picker')
        if (world.mock.downloads.length) add('I8', 'a cancelled Save downloaded')
    }
    if (facts.expectNoPicker && world.openings.length) add('I5', 'a picker opened that must not')

    // A flow that threw is a bug of its own (the Save's `exclusive` logs it).
    for (const error of world.errors)
        add(
            'flow threw',
            error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        )
    return found
}
