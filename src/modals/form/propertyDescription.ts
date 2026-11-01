import { computed, inject, provide, type InjectionKey } from 'vue'
import { i18n } from '../../i18n'
import { settings } from '../../settings'

type Localization = (typeof i18n)['value']

const propertyDescriptionsKey: InjectionKey<boolean> = Symbol('property descriptions')

/** Marks a surface whose property fields show their descriptions, such as Selection. */
export const providePropertyDescriptions = (on: boolean) => {
    provide(propertyDescriptionsKey, on)
}

/**
 * The property's description where its surface asks for descriptions. With Show Property
 * Descriptions off it is null, which keeps the field's row as it is with one. A surface that does
 * not ask, such as Brush or View, gets none.
 */
export const usePropertyDescription = <D>(get: (t: Localization) => D) => {
    const asked = inject(propertyDescriptionsKey, false)
    return computed(() =>
        asked ? (settings.showPropertyDescriptions ? get(i18n.value) : null) : undefined,
    )
}
