import { showModal } from '.'
import { i18n } from '../i18n'
import ChoiceModal from './ChoiceModal.vue'

export type Choice<T> = {
    value: T
    label: () => string
    /** A consequence the label does not show, not a definition of it. */
    description?: () => string
    /** Destructive or replacing: a quiet red label, and never the rightmost. */
    danger?: boolean
    /** The safe default: rightmost, primary, with focus. */
    default?: boolean
    /** Shown but not offered; its description says why. */
    disabled?: boolean
}

export type ChoiceButton = {
    value: unknown
    label: () => string
    description?: () => string
    danger?: boolean
    default?: boolean
    disabled?: boolean
    cancel?: boolean
}

export type ChoiceOptions<T> = {
    title: () => string
    message?: () => string
    /** Instead of `message`: each sentence its own paragraph. */
    lines?: () => string[]
    /** In button order, after Cancel. */
    choices: Choice<T>[]
    /** Cancel is the safe default, as in a destructive confirm: it takes the right-hand place. */
    cancelIsDefault?: boolean
    /** Replaces the Cancel label. */
    cancelLabel?: () => string
}

/**
 * The buttons in order, left to right: Cancel, the choices, then the safe default; with
 * `cancelIsDefault`, the choices, then Cancel.
 */
export const arrangeChoices = <T>(options: ChoiceOptions<T>): ChoiceButton[] => {
    const defaults = options.choices.filter((choice) => choice.default)
    const expected = options.cancelIsDefault ? 0 : 1
    if (defaults.length !== expected)
        throw new Error('A choice dialog declares exactly one safe default')
    if (defaults.some((choice) => choice.danger))
        throw new Error('The safe default of a choice dialog is never a danger choice')
    const cancel: ChoiceButton = {
        value: undefined,
        label: options.cancelLabel ?? (() => i18n.value.modals.confirm.cancel),
        cancel: true,
        default: options.cancelIsDefault,
    }
    const others = options.choices.filter((choice) => !choice.default)
    const buttons: ChoiceButton[] = options.cancelIsDefault
        ? [...others, cancel]
        : [cancel, ...others, ...defaults]
    return buttons
}

/** Shows a choice dialog; resolves to the chosen value, or undefined for Cancel, Esc, × or an outside press. */
export const showChoice = <T>(options: ChoiceOptions<T>) =>
    showModal(ChoiceModal, {
        title: options.title,
        message: options.message,
        lines: options.lines,
        buttons: arrangeChoices(options),
    }) as Promise<T | undefined>
