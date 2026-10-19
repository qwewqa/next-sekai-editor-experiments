import { watch } from 'vue'
import { onHistoryAction } from '../history/actions'
import { peekRequestGeneration, peekSourceGeneration } from '../history/peek'
import { session } from '../history/session'
import { liveState, peek, stackGeneration, stackMoveRequestGeneration } from '../history/stack'
import type { State } from '../state'
import { sameFileContent } from './file/content'

export type SwitchDestination = { state: State; sessionId: string; reset: boolean }

let latest = 0

/** A switch owns display permission, independently of any durable import it starts. */
export const createSwitchRequest = () => {
    const serial = ++latest
    let current = true
    let publishing: SwitchDestination | undefined
    let established = false
    let hadPeek = false
    let leftPeek = false
    let resetSeen = false
    let retained = 0
    let finished = false
    let generation = stackGeneration()
    let content = liveState.value
    const invalidate = () => {
        current = false
    }
    const matches = () =>
        !!publishing &&
        session.value.sessionId === publishing.sessionId &&
        stackGeneration() === generation + 1 &&
        sameFileContent(liveState.value, publishing.state)
    const stopContent = watch(
        liveState,
        (state) => {
            if (!sameFileContent(content, state) && !(publishing && !established) && !matches())
                current = false
            content = state
        },
        { flush: 'sync' },
    )
    const stopSession = watch(
        () => session.value.sessionId,
        (id) => {
            if (!publishing || id !== publishing.sessionId) invalidate()
        },
        { flush: 'sync' },
    )
    const stopPeek = watch(
        peekRequestGeneration,
        () => {
            if (
                publishing &&
                !established &&
                hadPeek &&
                !leftPeek &&
                !peek.value &&
                stackGeneration() === generation + 1
            ) {
                leftPeek = true
            } else invalidate()
        },
        { flush: 'sync' },
    )
    const stopContext = watch([peekSourceGeneration, stackMoveRequestGeneration], invalidate, {
        flush: 'sync',
    })
    const stopActions = onHistoryAction(({ kind }) => {
        if (kind === 'save' || kind === 'export') return
        if (publishing?.reset && kind === 'reset' && !resetSeen && matches()) {
            resetSeen = true
            established = true
            return
        }
        current = false
    })
    const isCurrent = () =>
        current && serial === latest && (generation === stackGeneration() || matches())
    const cancel = () => {
        current = false
    }
    const dispose = () => {
        finished = true
        if (retained) return
        cancel()
        stopContent()
        stopContext()
        stopSession()
        stopPeek()
        stopActions()
    }
    return {
        isCurrent,
        cancel,
        publish(destination: SwitchDestination, action: (installed: () => boolean) => void) {
            if (!isCurrent()) return false
            publishing = destination
            established = false
            hadPeek = !!peek.value
            leftPeek = false
            resetSeen = false
            try {
                action(() => {
                    established = true
                    if (!matches()) {
                        current = false
                        return false
                    }
                    return true
                })
            } finally {
                if (!matches() || resetSeen !== destination.reset || serial !== latest)
                    current = false
                publishing = undefined
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
