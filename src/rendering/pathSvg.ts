import { DrawPath } from './path'

type Point = readonly [number, number]

const tau = Math.PI * 2
const numberPattern = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y
const parameterCounts: Record<string, number> = {
    M: 2,
    L: 2,
    H: 1,
    V: 1,
    Q: 4,
    T: 2,
    C: 6,
    S: 4,
    A: 7,
}

function appendArc(
    path: DrawPath,
    from: Point,
    to: Point,
    radiusX: number,
    radiusY: number,
    degrees: number,
    large: boolean,
    sweep: boolean,
) {
    if (from[0] === to[0] && from[1] === to[1]) return
    if (!radiusX || !radiusY) {
        path.lineTo(...to)
        return
    }
    let rx = Math.abs(radiusX)
    let ry = Math.abs(radiusY)
    const rotation = ((degrees % 360) * Math.PI) / 180
    const c = Math.cos(rotation)
    const s = Math.sin(rotation)
    const dx = (from[0] - to[0]) / 2
    const dy = (from[1] - to[1]) / 2
    const px = c * dx + s * dy
    const py = -s * dx + c * dy
    const scale = Math.hypot(px / rx, py / ry)
    if (scale > 1) {
        rx *= scale
        ry *= scale
    }
    const distance = (px / rx) ** 2 + (py / ry) ** 2
    const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, (1 - distance) / distance))
    const centerX = (factor * rx * py) / ry
    const centerY = (-factor * ry * px) / rx
    const x = c * centerX - s * centerY + (from[0] + to[0]) / 2
    const y = s * centerX + c * centerY + (from[1] + to[1]) / 2
    const start = Math.atan2((py - centerY) / ry, (px - centerX) / rx)
    let delta = Math.atan2((-py - centerY) / ry, (-px - centerX) / rx) - start
    if (sweep && delta < 0) delta += tau
    if (!sweep && delta > 0) delta -= tau
    path.ellipse(x, y, rx, ry, rotation, start, start + delta, !sweep)
}

/** Parse SVG path data without Pixi's subpath/current-point and zero-radius arc differences. */
export function parseSvgPath(source: string): DrawPath {
    const path = new DrawPath()
    let index = 0
    let command = ''
    let previous = ''
    let current: Point = [0, 0]
    let subpath: Point = current
    let control: Point | undefined

    const skip = () => {
        while (index < source.length && /[\s,]/.test(source[index] ?? '')) index++
    }
    const readNumber = (flag: boolean) => {
        skip()
        if (flag) {
            const value = source[index]
            if (value !== '0' && value !== '1') return NaN
            index++
            return Number(value)
        }
        numberPattern.lastIndex = index
        const match = numberPattern.exec(source)
        if (!match) return NaN
        index = numberPattern.lastIndex
        return Number(match[0])
    }

    while (true) {
        skip()
        if (index >= source.length) break
        const next = source[index] ?? ''
        if (/[a-zA-Z]/.test(next)) {
            command = next
            index++
        }
        if (!command) break
        const operation = command.toUpperCase()
        const relative = command !== operation
        if (!previous && operation !== 'M') break
        if (operation === 'Z') {
            path.closePath()
            current = subpath
            control = undefined
            previous = operation
            command = ''
            continue
        }
        const count = parameterCounts[operation]
        if (count === undefined) break
        const values = Array.from({ length: count }, (_, i) =>
            readNumber(operation === 'A' && (i === 3 || i === 4)),
        )
        if (!values.every(Number.isFinite)) break
        const value = (i: number) => values[i] ?? NaN
        const point = (i: number): Point => [
            value(i) + (relative ? current[0] : 0),
            value(i + 1) + (relative ? current[1] : 0),
        ]
        let nextControl: Point | undefined
        switch (operation) {
            case 'M':
                current = point(0)
                path.moveTo(...current)
                subpath = current
                command = relative ? 'l' : 'L'
                break
            case 'L':
                current = point(0)
                path.lineTo(...current)
                break
            case 'H':
                current = [value(0) + (relative ? current[0] : 0), current[1]]
                path.lineTo(...current)
                break
            case 'V':
                current = [current[0], value(0) + (relative ? current[1] : 0)]
                path.lineTo(...current)
                break
            case 'Q': {
                nextControl = point(0)
                const end = point(2)
                path.quadraticCurveTo(...nextControl, ...end)
                current = end
                break
            }
            case 'T': {
                nextControl =
                    control && (previous === 'Q' || previous === 'T')
                        ? [2 * current[0] - control[0], 2 * current[1] - control[1]]
                        : current
                const end = point(0)
                path.quadraticCurveTo(...nextControl, ...end)
                current = end
                break
            }
            case 'C': {
                const first = point(0)
                nextControl = point(2)
                const end = point(4)
                path.bezierCurveTo(...first, ...nextControl, ...end)
                current = end
                break
            }
            case 'S': {
                const first: Point =
                    control && (previous === 'C' || previous === 'S')
                        ? [2 * current[0] - control[0], 2 * current[1] - control[1]]
                        : current
                nextControl = point(0)
                const end = point(2)
                path.bezierCurveTo(...first, ...nextControl, ...end)
                current = end
                break
            }
            case 'A': {
                const end = point(5)
                appendArc(path, current, end, value(0), value(1), value(2), !!value(3), !!value(4))
                current = end
                break
            }
        }
        control = nextControl
        previous = operation
    }
    return path
}
