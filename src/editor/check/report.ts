import type { MediaKind } from '../../local/nxsp/read'
import { interpolate } from '../../utils/interpolate'

// What Check File and History… tells (Part 1 §1.4.21): a few plain lines, in this order. The
// strings come in as a getter (the page's `i18n`), so this module loads in Node.

/** The strings the lines use: `check.*` and the media names of `open.media`. */
export type CheckText = {
    check: Record<
        | 'noDamage'
        | 'fileDamaged'
        | 'repaired'
        | 'storedDamaged'
        | 'mediaDamaged'
        | 'scopeBoth'
        | 'scopeStored',
        string
    >
    media: Record<MediaKind, string>
    /** `load.sessionLater` and `save.readFailed`: what a refused chain says. */
    refusal: { later: string; unreadable: string }
}

/**
 * The line for a chain this build cannot judge: a newer version's, or one it cannot read. Never
 * the storage line: storage worked.
 */
export const refusalLine = (
    reason: 'needsNewer' | 'unreadableHead' | 'order',
    name: string,
    text: () => CheckText,
): (() => string) =>
    reason === 'needsNewer'
        ? () => text().refusal.later
        : interpolate(() => text().refusal.unreadable, name)

export type Findings = {
    /** The file checked in full; absent when only the stored history was. */
    file?: { name: string }
    /** The file read as damaged: "Saving makes a separate file." */
    fileDamaged?: { name: string }
    /** Why the file was not checked, when a reason applies. */
    reason?: () => string
    /** Timeline steps stored in this browser that were not whole and are again. */
    repaired: number
    /** Timeline steps stored in this browser that are still not whole. */
    damaged: number
    /** The kinds of media found damaged in storage, whatever became of them. */
    media: readonly (readonly MediaKind[])[]
}

const KINDS: readonly MediaKind[] = ['bgm', 'cover', 'preview']

export const reportLines = (found: Findings, text: () => CheckText): (() => string)[] => {
    const lines: (() => string)[] = []
    const kinds = KINDS.filter((kind) => found.media.some((each) => each.includes(kind)))
    if (!found.fileDamaged && !found.repaired && !found.damaged && !kinds.length)
        lines.push(() => text().check.noDamage)
    if (found.fileDamaged)
        lines.push(interpolate(() => text().check.fileDamaged, found.fileDamaged.name))
    if (found.repaired) lines.push(interpolate(() => text().check.repaired, String(found.repaired)))
    if (found.damaged)
        lines.push(interpolate(() => text().check.storedDamaged, String(found.damaged)))
    for (const kind of kinds)
        lines.push(
            interpolate(
                () => text().check.mediaDamaged,
                () => text().media[kind],
            ),
        )
    lines.push(
        found.file
            ? interpolate(() => text().check.scopeBoth, found.file.name)
            : () => text().check.scopeStored,
    )
    if (found.reason) lines.push(found.reason)
    return lines
}
