import { onScopeDispose, ref } from 'vue'
import { errorMessage } from '../utils/error'
import { getDrawContext, type WebGLDrawContext } from './context'

/** Observe lazy pane initialization; the pane retains ownership of its canvases. */
export const useEditorRenderer = (reportError?: (error: unknown) => void) => {
    const error = ref<string>()
    const observed = new Map<HTMLCanvasElement, WebGLDrawContext>()
    const pending = new Set<HTMLCanvasElement>()
    const failed = new Set<HTMLCanvasElement>()
    let active = true

    const fail = (canvas: HTMLCanvasElement, reason: unknown) => {
        failed.add(canvas)
        error.value = errorMessage(reason)
        reportError?.(reason)
    }
    const forget = (canvas: HTMLCanvasElement) => {
        observed.delete(canvas)
        pending.delete(canvas)
        failed.delete(canvas)
    }
    onScopeDispose(() => {
        active = false
        observed.clear()
        pending.clear()
        failed.clear()
    })

    const getContext = (canvas: HTMLCanvasElement) => {
        if (!active || failed.has(canvas)) return
        let context: WebGLDrawContext
        try {
            context = getDrawContext(canvas)
        } catch (reason) {
            fail(canvas, reason)
            return
        }
        if (observed.get(canvas) !== context) {
            observed.set(canvas, context)
            pending.add(canvas)
            void context.ready.then(
                () => {
                    if (!active || observed.get(canvas) !== context) return
                    pending.delete(canvas)
                    if (!pending.size && !failed.size) error.value = undefined
                },
                (reason: unknown) => {
                    if (!active || observed.get(canvas) !== context) return
                    pending.delete(canvas)
                    fail(canvas, reason)
                },
            )
        }
        return context
    }
    return { error, getContext, forget }
}
