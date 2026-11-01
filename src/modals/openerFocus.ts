import { fieldControl, infoButtonOf } from './form/fieldFocus'

// Where focus goes when a dialog closes. The browser gives it back to what had it. When the dialog
// removed that, as hiding property descriptions removes an info button, focus goes to the nearest
// of what was around it that is left, so it never falls to the page.

/** What had focus before a dialog, and what was around it. */
export type Opener = {
    element: Element
    /** The info button, when focus was in its bubble, which closes as the dialog opens. */
    button: HTMLElement | null
    /** The elements around it, nearest first, up to its dock or dialog. */
    around: Element[]
}

// Where keys stay away from the chart's shortcuts, or are a dialog's own.
const REGION = '[data-workspace-dock], dialog, [data-tool-dialog]'
const FOCUSABLE = ':is(a[href], button, input, select, textarea, [tabindex]):not(:disabled)'

const shown = (element: Element | null | undefined): element is HTMLElement =>
    element instanceof HTMLElement && element.isConnected && element.getClientRects().length > 0

/** What has focus now, and what is around it inside its dock or dialog. */
export const rememberOpener = (): Opener | undefined => {
    const element = document.activeElement
    if (!element || element === document.body) return undefined
    const button = infoButtonOf(element)
    const around: Element[] = []
    const start = button ?? element
    // Outside a dock or dialog, what is around it could be any part of the page.
    if (start.closest(REGION))
        for (let at = start.parentElement; at; at = at.parentElement) {
            around.push(at)
            if (at.matches(REGION)) break
        }
    return { element, button, around }
}

/**
 * Focuses the first of these that is left and takes focus: what had focus, its info button, its
 * field's control, else the first control in the nearest element around it.
 */
export const focusOpener = ({ element, button, around }: Opener) => {
    const field = around.find((at) => at.matches('.form-field'))
    function* targets() {
        yield element
        yield button
        if (field?.isConnected) yield fieldControl(field)
        for (const at of around)
            if (at.isConnected)
                yield [at, ...at.querySelectorAll(FOCUSABLE)].find(
                    (candidate) => candidate.matches(FOCUSABLE) && shown(candidate),
                )
    }
    for (const target of targets()) {
        if (!shown(target)) continue
        target.focus({ preventScroll: true })
        if (document.activeElement === target) return
    }
}
