// The ranges numbers are sent as, and the function that finds one. No imports, so the counters
// (tally.ts) can use it from the main bundle.

/** The ranges numbers are sent as. Each list is in order, and each range's label is its value. */
export const scales = {
    /** Milliseconds. */
    time: [
        '<50',
        '50-100',
        '100-200',
        '200-500',
        '500-1k',
        '1k-2k',
        '2k-5k',
        '5k-10k',
        '10k-30k',
        '30k+',
    ],
    /** Bytes; K is KiB and M is MiB. */
    size: ['<16K', '16K-64K', '64K-256K', '256K-1M', '1M-4M', '4M-16M', '16M-64M', '64M+'],
    objects: [
        '0',
        '1-9',
        '10-99',
        '100-499',
        '500-999',
        '1k-2k',
        '2k-5k',
        '5k-10k',
        '10k-20k',
        '20k+',
    ],
    small: ['0', '1', '2-5', '6-20', '21-100', '101+'],
    /** An audio file's length. */
    audio: ['<1m', '1m-2m', '2m-3m', '3m-5m', '5m-10m', '10m+'],
    /** A long animation frame's length, in milliseconds. */
    frame: ['50-100', '100-200', '200-500', '500+'],
    quota: ['<1G', '1G-10G', '10G-100G', '100G+'],
    cores: ['1-2', '3-4', '5-8', '9+'],
    /** The window's width in CSS pixels. */
    viewport: ['s', 'm', 'l', 'xl'],
    dpr: ['1', '<2', '<3', '3+'],
    /** The preview's note speed; 10 is the default. */
    noteSpeed: ['<8', '8-10', '10', '10-12'],
} as const

export type Scale = keyof typeof scales

declare const scaleBrand: unique symbol
/** A range label, made only by `bucket`, so a raw number or string cannot be sent as one. */
export type Bucket<S extends Scale> = (typeof scales)[S][number] & { readonly [scaleBrand]: S }

const K = 1024
const M = K * K
const G = K * M
const MINUTE = 60_000

/** Each scale's upper limits, exclusive; a value at or past the last takes the last range. */
const limits: Record<Scale, readonly number[]> = {
    time: [50, 100, 200, 500, 1000, 2000, 5000, 10_000, 30_000],
    size: [16 * K, 64 * K, 256 * K, M, 4 * M, 16 * M, 64 * M],
    objects: [1, 10, 100, 500, 1000, 2000, 5000, 10_000, 20_000],
    small: [1, 2, 6, 21, 101],
    audio: [1, 2, 3, 5, 10].map((minutes) => minutes * MINUTE),
    frame: [100, 200, 500],
    quota: [G, 10 * G, 100 * G],
    cores: [3, 5, 9],
    viewport: [640, 1024, 1440],
    dpr: [1.01, 2, 3],
    noteSpeed: [8, 10, 10.000_001],
}

/** The range a number falls in. */
export const bucket = <S extends Scale>(scale: S, value: number): Bucket<S> => {
    const at = limits[scale].findIndex((limit) => value < limit)
    const labels = scales[scale]
    return labels[at < 0 ? labels.length - 1 : at] as Bucket<S>
}
