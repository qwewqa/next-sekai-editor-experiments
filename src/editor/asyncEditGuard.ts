import { watch } from 'vue'
import { onHistoryAction } from '../history/actions'
import { isPeeking, liveState, stackGeneration } from '../history/stack'
import type { State } from '../state'

const sameExcept = (a: object, b: object, skip: readonly string[]) =>
    Object.keys({ ...a, ...b }).every(
        (key) =>
            skip.includes(key) ||
            (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key],
    )

/**
 * Whether `next` is `prev` with only the audio of its named BGM attached (the held-BGM attach, a
 * background change that is no edit): nothing a dialog or a confirm read has changed.
 */
export const isAudioAttach = (prev: State, next: State) => {
    // Fixtures of tests have no BGM.
    const was = prev.bgm as State['bgm'] | undefined
    const now = next.bgm as State['bgm'] | undefined
    if (!was?.meta || was.buffer || !now?.buffer || now.meta?.hash !== was.meta.hash) return false
    return sameExcept(prev, next, ['bgm']) && sameExcept(was, now, ['buffer', 'source', 'waveform'])
}

export const createAsyncEditGuard = (signal?: AbortSignal) => {
    const generation = stackGeneration()
    let current = !isPeeking.value && !signal?.aborted
    const invalidate = () => {
        current = false
    }
    const stopState = watch(
        [liveState, isPeeking],
        ([state, peeking], [before, wasPeeking]) => {
            if (peeking === wasPeeking && isAudioAttach(before, state)) return
            invalidate()
        },
        { flush: 'sync' },
    )
    const stopActions = onHistoryAction(({ kind }) => {
        if (kind !== 'save' && kind !== 'export') invalidate()
    })
    const dispose = () => {
        invalidate()
        stopState()
        stopActions()
        signal?.removeEventListener('abort', dispose)
    }
    signal?.addEventListener('abort', dispose, { once: true })
    if (signal?.aborted) dispose()
    return {
        isCurrent: () => current && !isPeeking.value && generation === stackGeneration(),
        dispose,
    }
}
