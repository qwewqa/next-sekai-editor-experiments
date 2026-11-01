/**
 * Scrolls a target to the top of its scroller and focuses the heading it is given, as the section
 * index in Settings and Help does. The target is a section, or in Help an entry.
 */
export const landOn = (target: HTMLElement, heading: HTMLElement | null) => {
    target.scrollIntoView({ block: 'start' })
    heading?.focus({ preventScroll: true })
}
