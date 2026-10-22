import { computed, inject, type InjectionKey, type Ref } from 'vue'

/** Provided around fields that show a value and do not change it (Properties while peeking). */
export const fieldReadOnlyKey: InjectionKey<Readonly<Ref<boolean>>> = Symbol('field read only')

/** Whether the field is read-only: text stays readable and selectable, other controls are disabled. */
export const useFieldReadOnly = () => {
    const provided = inject(fieldReadOnlyKey, undefined)
    return computed(() => provided?.value ?? false)
}
