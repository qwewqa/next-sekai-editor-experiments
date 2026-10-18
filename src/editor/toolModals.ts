import { shallowRef, type Component } from 'vue'
import { closeModal, modals, showModal, type Modal, type ModalProps } from '../modals'
import { isElevationEditorOpen, isElevationSideBySide } from './elevation/state'
import { editorNavigation } from './navigation'
import { view } from './view'

export type ToolModalPane = NonNullable<Modal['pane']>

export const hasToolModal = (pane: ToolModalPane) =>
    modals.some((modal) => modal.presentation === 'tool' && modal.pane === pane)

/** Where the History sheet sits in its pane and how much of the pane it takes, for the notices. */
export const sheetBox = shallowRef<{ side: 'bottom' | 'right'; size: number }>()
export const peekClearance = shallowRef(0)

/**
 * Shows a tool dialog. A sheet leaves the tool as it is and sits in the main pane: History's,
 * over the live chart.
 */
export const showToolModal = <T extends Component>(
    component: T,
    props: ModalProps<T>,
    options?: { sheet?: boolean },
) => {
    for (const modal of [...modals]) {
        if (modal.presentation === 'tool') closeModal(modal)
    }
    view.entities = { hovered: [], creating: [] }
    return showModal(component, props, {
        presentation: 'tool',
        pane:
            !options?.sheet &&
            (editorNavigation.value ||
                (isElevationEditorOpen.value && !isElevationSideBySide.value))
                ? 'elevation'
                : 'main',
        ...(options?.sheet ? { sheet: true } : {}),
    })
}
