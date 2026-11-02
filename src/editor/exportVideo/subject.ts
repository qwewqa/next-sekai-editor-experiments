// What a video export is named after and remembered under: the chart on screen.

import type { SessionDescriptor } from '../../history/session'
import { displayName, namePartsOf, prefillOf } from '../../local/names'
import type { State } from '../../state'
import { validName } from '../commands/exportLevel/fileName'

/**
 * The suggested file name stem (empty for `Video`) and the chain the clip range is remembered
 * under. A peeked session is named as the peek bar names it and has no chain here, so nothing is
 * remembered for it.
 */
export const exportSubject = (
    open: SessionDescriptor,
    state: State,
    peeked?: { name: string },
): { stem: string; chain?: string } => {
    if (peeked) return { stem: validName(peeked.name) }
    const parts = namePartsOf(
        {
            name: open.name,
            sourceName: open.sourceName,
            ...(open.file ? { file: { name: open.file.name } } : {}),
        },
        state,
    )
    return { stem: validName(prefillOf(displayName(parts))), chain: open.docId }
}
