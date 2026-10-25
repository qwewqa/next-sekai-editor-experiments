// Settings' sections in their order: the index and openSettings(section) name them.
export const SETTINGS_SECTIONS = [
    'editor',
    'localData',
    'panels',
    'preview',
    'toolbar',
    'play',
    'touch',
    'mouse',
    'keyboardShortcuts',
    'about',
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]
