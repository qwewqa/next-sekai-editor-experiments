import { inject, type InjectionKey } from 'vue'
import { createFontContext } from '../../rendering/textRaster'
import { CHEVRON_CLEARANCE, PLAIN_PADDING } from './leadFit'

/** Fields whose value would truncate beside the label take the row below it. */
export const stackLongValuesKey: InjectionKey<boolean> = Symbol('stackLongValues')

export const useStackLongValues = () => inject(stackLongValuesKey, false)

/** Fields whose label would take more than two lines take the row below it. */
export const stackTallLabelsKey: InjectionKey<boolean> = Symbol('stackTallLabels')

export const useStackTallLabels = () => inject(stackTallLabelsKey, false)

let context: CanvasRenderingContext2D | null | undefined

/**
 * Read the available width before any labels switch to their intrinsic width: the longest word,
 * or with `whole` the full line.
 */
export const measureWord = (label: HTMLElement, whole = false) => {
    const { width, overflowWrap, flexShrink } = label.style
    const room = label.getBoundingClientRect().width
    return {
        prepare() {
            Object.assign(label.style, {
                width: whole ? 'max-content' : 'min-content',
                overflowWrap: 'normal',
                flexShrink: '0',
            })
        },
        overflows: () => label.getBoundingClientRect().width > room + 0.01,
        restore() {
            Object.assign(label.style, { width, overflowWrap, flexShrink })
        },
    }
}

/**
 * Whether a control's shown value, or any of `others` it can switch to, is wider
 * than the room its pill gives it.
 */
export const valueOverflows = (control: HTMLElement, others: string[] = []) => {
    const style = getComputedStyle(control)
    const measure = (context ??= createFontContext())
    if (!measure) return false
    measure.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    const text =
        control instanceof HTMLSelectElement
            ? (control.selectedOptions[0]?.textContent.trim() ?? '')
            : control instanceof HTMLInputElement
              ? control.value || control.placeholder
              : control.textContent.trim()
    // A leading glyph gives way before the value moves, so its room counts.
    const padding = parseFloat(style.paddingLeft)
    const left = control.closest('.form-field-select-leading')
        ? Math.min(padding, PLAIN_PADDING)
        : padding
    // A field select's value also keeps clear of its chevron.
    const clearance = control.closest('.form-field-select') ? CHEVRON_CLEARANCE : 0
    const room = control.clientWidth - left - parseFloat(style.paddingRight) - clearance
    return (
        Math.max(...[text, ...others].map((text) => measure.measureText(text).width)) > room + 0.5
    )
}

/**
 * Whether each label's longest word or phrase is wider than its box, so would break inside, or
 * with `whole` whether its full line is, so would wrap. All are read, then all set, then all read
 * again, so layout runs twice in all.
 */
export const wordsOverflow = (labels: HTMLElement[], whole = false) => {
    const measured = labels.map((label) => measureWord(label, whole))
    // Unshrunk, a label is as wide as its longest unbreakable part at min-content width, and as
    // its full line at max-content.
    for (const entry of measured) entry.prepare()
    const overflows = measured.map((entry) => entry.overflows())
    for (const entry of measured) entry.restore()
    // A word even a fraction wider than the box breaks.
    return overflows
}
