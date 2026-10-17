import type { InjectionKey } from 'vue'

/** Closes the Settings dialog, for a row whose button opens another one. */
export const closeSettingsKey: InjectionKey<() => void> = Symbol('closeSettings')
