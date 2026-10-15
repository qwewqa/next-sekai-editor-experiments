import type { WebGLDrawContext } from '../../src/rendering/context'

type LabelRecorder = {
    save(): void
    restore(): void
    translate(x: number, y: number): void
    scale(x: number, y: number): void
    fillText(text: string, x: number, y: number): void
    font: string
    fontKerning: string
    textBaseline: string
    textAlign: string
    fillStyle: unknown
}

// Expand the public label contract into the operations these unit recorders
// already observe. Browser pixel oracles exercise the real renderer; this
// adapter keeps domain tests checking label position, style, clips and order.
export function recordEditorLabel(
    this: LabelRecorder,
    ...[text, x, y, color, fontFamily, scale, size, align, middle]: Parameters<
        WebGLDrawContext['drawEditorLabel']
    >
) {
    this.save()
    this.translate(x, y)
    this.scale(1 / scale, 1 / scale)
    this.font = `${size * scale}px ${fontFamily}`
    this.fontKerning = 'normal'
    this.textBaseline = 'alphabetic'
    this.textAlign = align
    this.fillStyle = color
    this.fillText(text, 0, size * scale * middle)
    this.restore()
}
