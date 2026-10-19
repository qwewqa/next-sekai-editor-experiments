import { watch } from 'vue'
import { onHistoryAction } from '../history/actions'
import { isPeeking, liveState, stackGeneration } from '../history/stack'

export const createAsyncEditGuard = (signal?: AbortSignal) => {
    const generation = stackGeneration()
    let current = !isPeeking.value && !signal?.aborted
    const invalidate = () => { current = false }
    const stopState = watch([liveState, isPeeking], invalidate, { flush: 'sync' })
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
