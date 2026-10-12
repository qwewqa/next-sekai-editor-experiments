import { clipboardEntry, updateClipboard } from '../clipboard'
import type { Modifiers } from './controls/gestures/pointer'
import { editorNavigation } from './navigation'
import { pasteAtPosition, pastePositionAt, waitToPaste } from './tools/paste'
import { markTouchBeat } from './view'

export const pasteAtContextPosition = async (
    x: number,
    y: number,
    modifiers: Modifiers = { ctrl: false, shift: false },
) => {
    if (editorNavigation.value) return await editorNavigation.value.pasteAtPoint(x, y, modifiers)
    const position = pastePositionAt(x, y)
    if (!(await waitToPaste(updateClipboard, false))) return false

    const data = clipboardEntry.value?.data
    if (!data) return false

    const beat = await pasteAtPosition(position.lane, position.beatOffset(data.beat), modifiers, {
        composed: true,
    })
    if (beat !== undefined) markTouchBeat(beat)
    return true
}
