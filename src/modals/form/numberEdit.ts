import type { InjectionKey, Ref } from 'vue'

// Selected-object forms can preview number edits without making every input
// event an undo step. Other number fields retain their change-event behavior.
export type NumberEdit = {
    revision: Readonly<Ref<number>>
    preview: (owner: symbol, update: () => void) => void
    /** Previews each value in use set on its own: `update` sets the model for the objects holding it. */
    previewEach: (
        owner: symbol,
        values: Iterable<unknown>,
        update: (value: unknown) => void,
    ) => void
    invalidate: (owner: symbol) => void
    commit: (owner: symbol) => void
    cancel: (owner: symbol) => void
}

export const numberEditKey: InjectionKey<NumberEdit> = Symbol('number edit')
