/**
 * The control that takes a field's focus: the checked choice of a segmented control, else the
 * first enabled control other than the ⓘ.
 */
export const fieldControl = (field: Element) =>
    field.querySelector<HTMLElement>('input:checked:enabled') ??
    field.querySelector<HTMLElement>(
        ':is(select, input, button, [tabindex]):not([data-field-info], :disabled)',
    )

/** The info button whose bubble holds this element, as the bubble names it. */
export const infoButtonOf = (element: Element) => {
    const id = element.closest('[data-field-info-bubble]')?.getAttribute('data-field-info-bubble')
    return id ? document.getElementById(id) : null
}
