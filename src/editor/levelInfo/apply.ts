import { isPeeking, liveState, pushState } from '../../history'
import { createHistoryOperation } from '../../history/createHistoryOperation'
import { stackGeneration } from '../../history/stack'
import { levelInfoInput } from '../headerLabelText'
import { notify } from '../notification'
import { draftOver, type Draft } from './draft'

// A Level Info Apply: the draft as one step.

export type ApplyResult = 'applied' | 'unchanged' | 'refused'

/**
 * Pushes the draft as one step over the live state, which the dialog's own BGM changes may have
 * moved on from, so only the fields the user changed are written. Nothing is applied when a peek
 * began or the stack was replaced (another session) since the dialog opened, or when nothing
 * changed.
 */
export const applyLevelInfo = (opening: Draft, draft: Draft, generation: number): ApplyResult => {
    if (isPeeking.value || generation !== stackGeneration()) return 'refused'
    const live = liveState.value
    const after = draftOver(opening, draft, live)
    const input = levelInfoInput(live.levelInfo, after.levelInfo, {
        before: live.initialLife,
        after: after.life,
    })
    if (!input) return 'unchanged'
    const operation = createHistoryOperation(input)
    const pushed = pushState(operation, {
        ...live,
        levelInfo: after.levelInfo,
        initialLife: after.life,
    })
    if (pushed) notify(() => operation.fallback.text)
    return 'applied'
}
