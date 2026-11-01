/** Blur in the untransformed image plane, with a transparent three-sigma margin. */
export const backgroundBlurSize = (width: number, height: number, sigma: number) => {
    const margin = 3 * sigma
    const scale = Math.min(1, 8 / sigma, 2048 / Math.max(width + 2 * margin, height + 2 * margin))
    return {
        width: Math.max(1, Math.min(2048, Math.ceil((width + 2 * margin) * scale))),
        height: Math.max(1, Math.min(2048, Math.ceil((height + 2 * margin) * scale))),
        sigma: sigma * scale,
        marginX: margin / width,
        marginY: margin / height,
    }
}

/** Background packages accept hex colours; a missing colour is transparent. */
export const backgroundColor = (value: string | undefined): [number, number, number, number] => {
    if (!value || value === 'transparent') return [0, 0, 0, 0]
    let hex = value.slice(1)
    if (hex.length <= 4) hex = hex.replace(/[\da-f]/gi, '$&$&')
    if (hex.length === 6) hex += 'ff'
    const alpha = Number.parseInt(hex.slice(6, 8), 16) / 255
    return [
        (Number.parseInt(hex.slice(0, 2), 16) / 255) * alpha,
        (Number.parseInt(hex.slice(2, 4), 16) / 255) * alpha,
        (Number.parseInt(hex.slice(4, 6), 16) / 255) * alpha,
        alpha,
    ]
}
