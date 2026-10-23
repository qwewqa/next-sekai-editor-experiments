import { i18n } from '../../i18n'
import type { MediaKind } from '../../local/nxsp/read'
import { interpolate } from '../../utils/interpolate'

// What Check File and History… tells (Part 1 §1.4.21): a few plain lines, in this order.

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

export const reportLines = (found: Findings): (() => string)[] => {
    const lines: (() => string)[] = []
    const kinds = KINDS.filter((kind) => found.media.some((each) => each.includes(kind)))
    if (!found.fileDamaged && !found.repaired && !found.damaged && !kinds.length)
        lines.push(() => i18n.value.check.noDamage)
    if (found.fileDamaged)
        lines.push(interpolate(() => i18n.value.check.fileDamaged, found.fileDamaged.name))
    if (found.repaired)
        lines.push(interpolate(() => i18n.value.check.repaired, String(found.repaired)))
    if (found.damaged)
        lines.push(interpolate(() => i18n.value.check.storedDamaged, String(found.damaged)))
    for (const kind of kinds)
        lines.push(
            interpolate(
                () => i18n.value.check.mediaDamaged,
                () => i18n.value.open.media[kind],
            ),
        )
    lines.push(
        found.file
            ? interpolate(() => i18n.value.check.scopeBoth, found.file.name)
            : () => i18n.value.check.scopeStored,
    )
    if (found.reason) lines.push(found.reason)
    return lines
}
