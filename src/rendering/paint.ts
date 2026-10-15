export type Color = [number, number, number, number]
type Stop = { offset: number; color: Color }
// Stop-loop bounds establish these indices before access.
const indexed = <T>(values: ArrayLike<T>, index: number): T => values[index] as T
const colors = new Map<string, Color>()
const namedColors: Record<string, Color> = {
    white: [1, 1, 1, 1],
    black: [0, 0, 0, 1],
    transparent: [0, 0, 0, 0],
    red: [1, 0, 0, 1],
    blue: [0, 0, 1, 1],
    green: [0, 0.5, 0, 1],
}
let colorProbe: HTMLSpanElement | undefined
const normalizeColor = (input: string) => {
    if (/^#[\da-f]+$/i.test(input) || /^rgba?\([^)]*,/.test(input)) return input
    // Resolve infrequent CSS names, HSL and space-separated RGB without a
    // browser canvas. The parsed result is cached under the original string.
    colorProbe ??= document.createElement('span')
    colorProbe.style.cssText = 'display:none;color:black'
    colorProbe.style.color = input
    document.documentElement.append(colorProbe)
    const normalized = getComputedStyle(colorProbe).color
    colorProbe.remove()
    return normalized
}
export const parseColor = (input: string): Color => {
    const cached = colors.get(input)
    if (cached) return cached
    let color: Color
    const named = namedColors[input]
    const normalized = named ? input : normalizeColor(input)
    if (named) color = named
    else if (normalized.startsWith('#')) {
        let hex = normalized.slice(1)
        if (hex.length < 5) hex = hex.replace(/[\da-f]/gi, '$&$&')
        color = [
            parseInt(hex.slice(0, 2), 16) / 255,
            parseInt(hex.slice(2, 4), 16) / 255,
            parseInt(hex.slice(4, 6), 16) / 255,
            hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
        ]
    } else if (normalized.startsWith('rgb')) {
        const values = normalized.match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?%?/gi) ?? []
        const channel = (i: number, alpha = false) => {
            const value = values[i] ?? (alpha ? '1' : '0')
            return Math.max(
                0,
                Math.min(1, parseFloat(value) / (value.endsWith('%') ? 100 : alpha ? 1 : 255)),
            )
        }
        color = [channel(0), channel(1), channel(2), channel(3, true)]
    } else color = [0, 0, 0, 1]
    colors.set(input, color)
    if (colors.size > 2048) {
        const first = colors.keys().next()
        if (!first.done) colors.delete(first.value)
    }
    return color
}
let id = 0
export class DrawGradient {
    id = ++id
    readonly stops: Stop[] = []
    constructor(
        readonly start: [number, number],
        readonly end: [number, number],
    ) {}
    addColorStop(offset: number, color: string) {
        if (offset < 0 || offset > 1 || !Number.isFinite(offset))
            throw new DOMException('Invalid gradient offset', 'IndexSizeError')
        this.stops.push({ offset, color: parseColor(color) })
        this.stops.sort((a, b) => a.offset - b.offset)
        this.id = ++id
    }
    at(x: number, y: number, out: Color = [0, 0, 0, 0]): Color {
        const dx = this.end[0] - this.start[0],
            dy = this.end[1] - this.start[1]
        const t = ((x - this.start[0]) * dx + (y - this.start[1]) * dy) / (dx * dx + dy * dy || 1)
        const first = this.stops[0]
        if (!first) return [0, 0, 0, 0]
        let a = first
        for (let i = 1; i < this.stops.length; i++) {
            const b = indexed(this.stops, i)
            if (t < b.offset) {
                const q = Math.max(0, Math.min(1, (t - a.offset) / (b.offset - a.offset || 1)))
                out[0] = a.color[0] + (b.color[0] - a.color[0]) * q
                out[1] = a.color[1] + (b.color[1] - a.color[1]) * q
                out[2] = a.color[2] + (b.color[2] - a.color[2]) * q
                out[3] = a.color[3] + (b.color[3] - a.color[3]) * q
                return out
            }
            a = b
        }
        return a.color
    }
}
export type DrawStyle = string | DrawGradient
