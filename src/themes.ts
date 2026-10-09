// Each theme has a block in themes.css and a name under settings.editor.theme; light is the default.
export const themes = ['light', 'dark'] as const

export type Theme = (typeof themes)[number]
