import { watch } from 'vue'
import { onHistoryAction } from '../history/actions'
import { peekedInfo, peekedKey, peekSourceGeneration } from '../history/peek'
import { session } from '../history/session'
import { liveState, stackGeneration } from '../history/stack'
import { sameFileContent } from './file/content'

let latest = 0

/** A switch owns display permission, independently of any durable import it starts. */
export const createSwitchRequest = () => {
    const serial = ++latest
    let current = true
    let publishing = false
    let resetSeen = false
    let retained = 0
    let finished = false
    let generation = stackGeneration()
    let content = liveState.value
    const invalidate = () => {
        if (!publishing) current = false
    }
    const stopContent = watch(
        liveState,
        (state) => {
            if (!publishing && !sameFileContent(content, state)) current = false
            content = state
        },
        { flush: 'sync' },
    )
    const stopContext = watch(
        [() => session.value.sessionId, peekedKey, peekedInfo, peekSourceGeneration],
        invalidate,
        { flush: 'sync' },
    )
    const stopActions = onHistoryAction(({ kind }) => {
        if (kind === 'save' || kind === 'export') return
        if (publishing && kind === 'reset' && !resetSeen) {
            resetSeen = true
            return
        }
        current = false
    })
    const isCurrent = () => current && serial === latest && generation === stackGeneration()
    const cancel = () => {
        current = false
    }
    const dispose = () => {
        finished = true
        if (retained) return
        cancel()
        stopContent()
        stopContext()
        stopActions()
    }
    return {
        isCurrent,
        cancel,
        publish(action: () => void) {
            if (!isCurrent()) return false
            publishing = true
            resetSeen = false
            try {
                action()
            } finally {
                publishing = false
                if (serial !== latest) current = false
                generation = stackGeneration()
                content = liveState.value
            }
            return isCurrent()
        },
        observeAbort(signal: AbortSignal) {
            signal.addEventListener('abort', cancel, { once: true })
            if (signal.aborted) cancel()
            return () => signal.removeEventListener('abort', cancel)
        },
        retainUntil(task: Promise<unknown>) {
            retained++
            const release = () => {
                retained--
                if (finished) dispose()
            }
            void task.then(release, release)
        },
        dispose,
    }
}

export type SwitchRequest = ReturnType<typeof createSwitchRequest>

export const withSwitchRequest = async <T>(
    supplied: SwitchRequest | undefined,
    run: (request: SwitchRequest) => Promise<T>,
) => {
    const request = supplied ?? createSwitchRequest()
    try {
        return await run(request)
    } finally {
        if (!supplied) request.dispose()
    }
}
