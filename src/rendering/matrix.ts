export type Matrix = [number, number, number, number, number, number]
export const identity = (): Matrix => [1, 0, 0, 1, 0, 0]
export const matrixOf = (m: DOMMatrix2DInit): Matrix => [
    m.a ?? m.m11 ?? 1,
    m.b ?? m.m12 ?? 0,
    m.c ?? m.m21 ?? 0,
    m.d ?? m.m22 ?? 1,
    m.e ?? m.m41 ?? 0,
    m.f ?? m.m42 ?? 0,
]
export const matrixObject = ([a, b, c, d, e, f]: Matrix): DOMMatrix2DInit => ({ a, b, c, d, e, f })
export const equalMatrix = (a: Matrix, b: Matrix) => a.every((v, i) => v === b[i])
export const multiply = (a: Matrix, b: Matrix): Matrix => [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
]
export const inverse = (m: Matrix): Matrix | undefined => {
    const det = m[0] * m[3] - m[1] * m[2]
    if (!det || !Number.isFinite(det)) return
    return [
        m[3] / det,
        -m[1] / det,
        -m[2] / det,
        m[0] / det,
        (m[2] * m[5] - m[3] * m[4]) / det,
        (m[1] * m[4] - m[0] * m[5]) / det,
    ]
}
