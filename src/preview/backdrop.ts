import { parseColor } from '../rendering/paint'

/** The preview's backdrop colour for the current theme, as the preview and Export Video draw it. */
export const readPreviewBackdrop = (): readonly [number, number, number] => {
    const color = getComputedStyle(document.documentElement).getPropertyValue('--color-preview')
    const [r, g, b] = parseColor(color.trim())
    return [r, g, b]
}
