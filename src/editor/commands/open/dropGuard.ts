import { i18n } from '../../../i18n'
import { isPersistentModalOpen } from '../../../modals'
import { notify } from '../../notification'

// No drag-and-drop to open. Without a handler the browser would navigate
// to a dropped file and leave the editor, so dragover and drop only call preventDefault().
// Text dragged into a field keeps its default.

const carriesFiles = (event: DragEvent) => !!event.dataTransfer?.types.includes('Files')

// Text-entry fields only: a link dropped on a checkbox or a slider would navigate the tab.
const textField =
    'input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="email"], input[type="number"], input[type="tel"], input[type="password"], textarea, [contenteditable]:not([contenteditable="false"])'

const intoField = (event: DragEvent) =>
    event.target instanceof HTMLElement && !!event.target.closest(textField)

const onDragover = (event: DragEvent) => {
    if (carriesFiles(event) || !intoField(event)) event.preventDefault()
}

const onDrop = (event: DragEvent) => {
    const files = carriesFiles(event)
    if (!files && intoField(event)) return
    event.preventDefault()
    // Nothing is read or opened. Under a persistent dialog no notice shows either, because it would
    // replace the start-up notice that the load's other notices wait on.
    if (files && !isPersistentModalOpen.value) notify(() => i18n.value.notice.useOpenFile)
}

let installed = false

export const installDropGuard = () => {
    if (installed || typeof document === 'undefined') return
    installed = true
    document.addEventListener('dragover', onDragover)
    document.addEventListener('drop', onDrop)
}
