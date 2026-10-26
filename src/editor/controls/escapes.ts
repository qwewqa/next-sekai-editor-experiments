// Open toolbar flyouts' Escape handlers, run after a drag's and before any pane's or drawer's.
export const flyoutEscapes = new Set<(event: KeyboardEvent) => void>()

// Resize handles keep the previously focused control, so their pointer gestures
// must own Escape before the active pane or focused control receives it.
export const resizeEscapes = new Set<() => void>()
