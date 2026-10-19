import { shallowReactive, watch } from 'vue'
import { historySheetFits, prospectivePeekClearance } from '../sheetGeometry'
import { peekClearance } from '../toolModals'
import { view } from '../view'
import { peekLayout, peekWidths } from './peekFit'
import type { Target } from './source'
import { hereRange, historyFilter, historyViewGeneration } from './state'

export type HistoryCloseResult = 'view-chart'
export type GoToView = {
    current?: Target | 'now'
    activeId?: string
    top: number
    focus?: string
}

export type HistoryPresentation = {
    compact: boolean
    registerView: (capture: () => void) => () => void
    takeFocusTarget: () => string | undefined
    measureChrome: (height: number) => void
    rememberGoTo: (view: GoToView | undefined, generation: number) => void
    takeGoTo: () => GoToView | undefined
}

/** A sheet may promote once; it never changes presentation back during this opening. */
export const createHistoryPresentation = (filtered: () => boolean, promote: () => void) => {
    const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    let measuredChrome: number | undefined
    let captureView: (() => void) | undefined
    let focusTarget: string | undefined
    const goToIdentity = () =>
        [
            historyViewGeneration(),
            historyFilter.value,
            hereRange.value?.from,
            hereRange.value?.to,
        ].join('|')
    let goTo: { identity: string; view: GoToView } | undefined
    const fits = () => {
        const widths = peekWidths.value
        const inset = widths && (peekLayout(view.w, widths).inset === 'pt-2' ? 0.5 : 1.75) * rem()
        const clearance = prospectivePeekClearance(view.w, peekClearance.value, rem(), inset)
        return (
            clearance !== undefined &&
            historySheetFits(
                { width: view.w, height: view.h, peekClearance: clearance, rem: rem() },
                measuredChrome ?? (48 + (filtered() ? 40 : 0)) * (rem() / 16),
            )
        )
    }
    let frame = 0
    let closed = false
    const check = () => {
        if (closed || state.compact || fits() || frame) return
        frame = requestAnimationFrame(() => {
            frame = 0
            if (closed || state.compact || fits()) return
            captureView?.()
            const active = document.activeElement
            focusTarget = active instanceof HTMLElement ? active.dataset.historyFocus : undefined
            state.compact = true
            promote()
        })
    }
    const state = shallowReactive<HistoryPresentation>({
        compact: !fits(),
        rememberGoTo(view, generation) {
            goTo =
                view && generation === historyViewGeneration()
                    ? { identity: goToIdentity(), view }
                    : undefined
        },
        takeGoTo() {
            const saved = goTo
            goTo = undefined
            return saved?.identity === goToIdentity() ? saved.view : undefined
        },
        registerView(capture) {
            captureView = capture
            return () => {
                if (captureView === capture) captureView = undefined
            }
        },
        takeFocusTarget() {
            const target = focusTarget
            focusTarget = undefined
            return target
        },
        measureChrome(height) {
            measuredChrome = height
            check()
        },
    })
    const stop = watch([() => view.w, () => view.h, peekClearance, filtered], check, {
        flush: 'post',
    })
    return {
        state,
        stop() {
            closed = true
            goTo = undefined
            stop()
            cancelAnimationFrame(frame)
        },
    }
}
