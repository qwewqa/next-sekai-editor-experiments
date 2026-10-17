import { i18n } from '../../../i18n'
import { notify } from '../../notification'

// No drag-and-drop to open (Part 1 §1.5.3, Z22). Without a handler the browser would navigate
// to a dropped file and leave the editor, so dragover and drop only call preventDefault().
// Text dragged into a field keeps its default.

const carriesFiles = (event: DragEvent) => !!event.dataTransfer?.types.includes('Files')

const intoField = (event: DragEvent) =>
    event.target instanceof HTMLElement &&
    !!event.target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')

const onDragover = (event: DragEvent) => {
    if (carriesFiles(event) || !intoField(event)) event.preventDefault()
}

const onDrop = (event: DragEvent) => {
    const files = carriesFiles(event)
    if (!files && intoField(event)) return
    event.preventDefault()
    // Nothing is read or opened.
    if (files) notify(() => i18n.value.notice.useOpenFile)
}

let installed = false

export const installDropGuard = () => {
    if (installed || typeof document === 'undefined') return
    installed = true
    document.addEventListener('dragover', onDragover)
    document.addEventListener('drop', onDrop)
}
