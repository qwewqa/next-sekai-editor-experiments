import { computed, shallowReactive, type Component, type ComponentInstance } from 'vue'

let id = 0

export type Modal = {
    id: number
    is: Component
    props: object
    resolve: (result?: never) => void
    presentation?: 'tool'
    pane?: 'main' | 'elevation'
    /** A fixed-height dialog filling most of the screen. */
    size?: 'large'
    /** With `large`: full height at every width, no cap, and v0.5.22's width. */
    tall?: boolean
    /** With `large`: the tallest it grows on wide screens (a CSS length); the default is 48rem. */
    cap?: string
    /** A tool dialog that leaves the tool as it is: the History sheet over the live chart. */
    sheet?: boolean
    /** Only its own button closes it: Escape and the backdrop do nothing, and a close by the browser opens it again. */
    persistent?: boolean
}

export const modals = shallowReactive<Modal[]>([])

/** A tool dialog that suspends the tool; a sheet does not. */
export const isToolModalOpen = computed(() =>
    modals.some((modal) => modal.presentation === 'tool' && !modal.sheet),
)

/** Any tool dialog, which takes Escape. */
export const isToolDialogOpen = computed(() =>
    modals.some((modal) => modal.presentation === 'tool'),
)

/** Dialogs that hold the editor; tool dialogs float over a live chart instead. */
export const isBlockingModalOpen = computed(() =>
    modals.some((modal) => modal.presentation !== 'tool'),
)

/** A persistent dialog is open: the page under it stays inert even while the browser closes it. */
export const isPersistentModalOpen = computed(() => modals.some((modal) => modal.persistent))

export const closeModal = (modal: Modal, result?: never) => {
    const index = modals.indexOf(modal)
    if (index === -1) return
    modals.splice(index, 1)
    modal.resolve(result)
}

export type ModalProps<T extends Component> = ComponentInstance<T>['$props']

type ModalResult<T extends Component> = ComponentInstance<T>['$emit'] extends (
    event: 'close',
    result: infer R,
) => void
    ? R
    : never

export const showModal = <T extends Component>(
    component: T,
    props: ModalProps<T>,
    options?: Pick<
        Modal,
        'presentation' | 'pane' | 'size' | 'tall' | 'cap' | 'sheet' | 'persistent'
    >,
) =>
    new Promise<ModalResult<T> | undefined>((resolve) => {
        modals.push({
            id: id++,
            is: component,
            props,
            resolve,
            ...options,
        })
    })
