import { bytesOf, sameBytes, startsWith, type World } from './world'

// The six invariants of work/arch/spec-B.md (I1 to I6), as checks over what
// a world recorded, plus three the task adds: the marker only for a write that may have landed
// (I7), cancel at any await (I8: nothing written, nothing held), one binding per file (I9), and a
// cancel after the pick that stops nothing (I10).

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
    /** The dialog was cancelled once the picker had returned a file: the write must still land (I10). */
    written?: boolean
    /**
     * A takeover storage could not record (R11): that file is never written, and the chain bound
     * to it keeps the binding (I9).
     */
    notTakenOver?: { chainId: string; name: string }
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
    const reserved = world.session.reserved
    if (reserved !== undefined) add('I3', `the session still holds reserved seq ${reserved.seq}`)

    // I4: no picker opens on a lapsed activation without a ready press.
    for (const opening of world.openings)
        if (!opening.activation) add('I4', `a picker opened for ${opening.name} without activation`)

    // I5: no picker opens while an import of this tab runs (any session's), nor while a copy of an
    // opened file is being kept, nor with one pending in storage before the bounded wait
    // (`RESUME_WAIT_MS`, which a pending import that never starts runs out) is over.
    for (const opening of world.openings) {
        if (opening.importing) add('I5', `a picker opened for ${opening.name} during the import`)
        else if (opening.copying)
            add('I5', `a picker opened for ${opening.name} while a copy was being kept`)
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

    // I10: once the picker returned a file, no Cancel stops the write (spec B rule 6).
    // The pick's own write lands (a put-back is a write too, so a failure shown means it did not).
    if (
        facts.written &&
        (!world.writes.some((write) => write.picked) ||
            world.dialogs.some((dialog) => ['failed', 'export.failed'].includes(dialog.kind)))
    )
        add('I10', 'a cancel after the pick stopped the write')

    // I9 (E-5): one file, one binding. No file name is bound to two chains, and no file is both
    // bound and another chain's Export target. Read from the store through the door, not from the
    // world's view of it.
    const stored = await world.storedChains()
    const bound = new Map<string, string[]>()
    const targets = new Map<string, string[]>()
    for (const record of stored) {
        const chainId = String(record.chainId)
        const file = record.file as { name?: string } | undefined
        const target = record.exportTarget as { name?: string } | undefined
        if (file?.name) bound.set(file.name, [...(bound.get(file.name) ?? []), chainId])
        if (target?.name) targets.set(target.name, [...(targets.get(target.name) ?? []), chainId])
    }
    for (const [name, chainIds] of bound) {
        if (chainIds.length > 1) add('I9', `${name} is bound to ${chainIds.join(' and ')}`)
        for (const target of targets.get(name) ?? [])
            if (!chainIds.includes(target))
                add(
                    'I9',
                    `${name} is bound to ${chainIds.join(', ')} and is ${target}’s Export target`,
                )
    }

    // I9 (R11): a takeover storage could not record writes nothing new to that file (it ends
    // empty, or holding what it held at its pick, put back), and the chain bound to it keeps its
    // binding.
    if (facts.notTakenOver) {
        const { chainId, name } = facts.notTakenOver
        const now = await bytesOf(world.mock.files.get(name))
        const held = world.before.get(name)
        const before = held ? await bytesOf(held) : undefined
        if (now?.length && !(before && sameBytes(now, before)))
            add('I9', `${name} holds new bytes though its takeover was not recorded`)
        const owner = stored.find((record) => record.chainId === chainId)
        if ((owner?.file as { name?: string } | undefined)?.name !== name)
            add('I9', `${chainId} lost its binding of ${name} though the takeover was not recorded`)
    }

    // A flow that threw is a bug of its own (the Save's `exclusive` logs it).
    for (const error of world.errors)
        add(
            'flow threw',
            error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        )
    return found
}
