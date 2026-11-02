import { parseColor } from '../rendering/paint'

/** The preview's backdrop colour for the current theme, as the preview and Export Video draw it. */
export const readPreviewBackdrop = (): readonly [number, number, number] => {
    const channels = getComputedStyle(document.documentElement).getPropertyValue('--color-preview')
    const [r, g, b] = parseColor(`rgb(${channels.trim()})`)
    return [r, g, b]
}
