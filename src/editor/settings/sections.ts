// Settings' sections in their order (Part 1 §1.4.14): the index and openSettings(section) name them.
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
