// The ranges numbers are sent as, and the function that finds one. No imports, so the counters
// (tally.ts) can use it from the main bundle.

const K = 1024
const M = K * K
const G = K * M

/** An exclusive upper limit, or `{ upTo }` for an inclusive one. */
type Limit = number | { readonly upTo: number }
type Scale_ = { readonly labels: readonly string[]; readonly limits: readonly Limit[] }

/**
 * A scale from ascending edges: a first range below the first edge, one range between each two
 * edges, and a last range from the final edge. `label` writes an edge; `unit` is how many raw
 * units one labelled unit holds.
 */
const fromEdges = (edges: readonly number[], label: (edge: number) => string, unit = 1): Scale_ => {
    const names = edges.map(label)
    const labels = [`<${names[0] ?? ''}`]
    names.forEach((name, i) => {
        const next = names[i + 1]
        labels.push(next === undefined ? `${name}+` : `${name}-${next}`)
    })
    return { labels, limits: edges.map((edge) => edge * unit) }
}

/** 0 to 9 exact, then ten ranges a decade up to 99999, then 100000+. */
const countScale = (): Scale_ => {
    const labels = Array.from({ length: 10 }, (_, i) => String(i))
    const limits: number[] = Array.from({ length: 10 }, (_, i) => i + 1)
    const steps = [10, 13, 16, 20, 25, 32, 40, 50, 63, 80]
    const edges = [1, 10, 100, 1000].flatMap((decade) => steps.map((step) => step * decade))
    edges.forEach((edge, i) => {
        const next = edges[i + 1] ?? 100_000
        labels.push(`${edge}-${next - 1}`)
        limits.push(next)
    })
    labels.push('100000+')
    return { labels, limits }
}

const sizeLabel = (bytes: number) =>
    bytes >= G ? `${bytes / G}G` : bytes >= M ? `${bytes / M}M` : `${bytes / K}K`

const sizeEdges = Array.from({ length: 21 }, (_, i) => 16 * K * 2 ** i)

/** One range for each of 1 to 32, then five wider ones. */
const coreScale = (): Scale_ => ({
    labels: [
        ...Array.from({ length: 32 }, (_, i) => String(i + 1)),
        '33-48',
        '49-64',
        '65-96',
        '97-128',
        '129+',
    ],
    limits: [...Array.from({ length: 32 }, (_, i) => i + 2), 49, 65, 97, 129],
})

const audioEdges = [
    10, 13, 16, 20, 25, 32, 40, 50, 63, 80, 100, 125, 160, 200, 250, 320, 400, 500, 630, 800, 1000,
    1200,
]

const defined = {
    /** A chart's object counts. */
    counts: countScale(),
    /** An audio file's length, labelled in seconds and measured in milliseconds. */
    audio: fromEdges(audioEdges, String, 1000),
    /** Bytes; K is KiB, M is MiB and G is GiB. */
    size: fromEdges(sizeEdges, sizeLabel),
    /** The browser's storage quota in bytes. */
    quota: fromEdges([256 * M, G, 4 * G, 16 * G, 64 * G, 256 * G], sizeLabel),
    /** Usage as a percent of the quota. The 80 edge is inclusive: cleanup starts above 80. */
    usageShare: {
        labels: ['<50', '50-70', '70-80', '80-90', '90-95', '95-100', '100+'],
        limits: [50, 70, { upTo: 80 }, 90, 95, 100],
    },
    /**
     * The workspace's width in CSS pixels. 2880 is 3K laptops at 100%, 3440 is 21:9 ultrawide, 3840
     * is 4K at 100% and 5120 is 5K or 32:9.
     */
    viewport: fromEdges(
        [360, 400, 480, 640, 768, 1000, 1100, 1440, 1920, 2560, 2880, 3440, 3840, 5120],
        String,
    ),
    /**
     * The workspace's height in CSS pixels. 500 and 600 are where the notice sheet changes shape
     * (sheetGeometry.ts); 500 is also the Settings index's short-screen limit.
     * 2160 is 4K's height.
     */
    viewportHeight: fromEdges([400, 500, 600, 768, 900, 1080, 1440, 2160], String),
    /**
     * The workspace's width divided by its height, in steps of 0.1 to 2 and then wider. The edges
     * are regular and not named ratios, because browser toolbars shift every screen's ratio; 1 is
     * the edge between portrait and landscape.
     */
    viewportAspect: fromEdges(
        [
            0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2, 2.2,
            2.4, 2.6, 2.8, 3, 3.5, 4,
        ],
        String,
    ),
    /** The device pixel ratio. 1.25, 1.5 and 1.75 are Windows' 125%, 150% and 175%. */
    dpr: {
        labels: [
            '<1',
            '1',
            '1-1.25',
            '1.25',
            '1.25-1.5',
            '1.5',
            '1.5-1.75',
            '1.75',
            '1.75-2',
            '2',
            '2-2.5',
            '2.5-3',
            '3',
            '3+',
        ],
        limits: [
            1,
            { upTo: 1 },
            1.25,
            { upTo: 1.25 },
            1.5,
            { upTo: 1.5 },
            1.75,
            { upTo: 1.75 },
            2,
            { upTo: 2 },
            2.5,
            3,
            { upTo: 3 },
        ],
    },
    /** The preview's note speed; 10 is the default. */
    noteSpeed: {
        labels: ['1-5', '5-8', '8-9', '9-10', '10', '10-10.5', '10.5-11', '11-11.5', '11.5-12'],
        limits: [5, 8, 9, 10, { upTo: 10 }, 10.5, 11, 11.5],
    },
    /** A Timeline step's time to show, in milliseconds, on the R5 preferred numbers. */
    peek: fromEdges(
        [
            10, 16, 25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10_000,
            16_000, 25_000,
        ],
        (edge) => (edge >= 1000 ? `${edge / 1000}k` : String(edge)),
    ),
    /** A long animation frame's length, in milliseconds. */
    frame: {
        labels: ['50-100', '100-200', '200-500', '500-1000', '1000-2000', '2000+'],
        limits: [100, 200, 500, 1000, 2000],
    },
    /** A slow event's duration, in milliseconds. */
    slowEvent: {
        labels: ['104-200', '200-500', '500-1000', '1000+'],
        limits: [200, 500, 1000],
    },
    cores: coreScale(),
    /** A dock body's width, or the top dock's height, in CSS pixels. */
    dockSize: {
        labels: ['0-280', '280-400', '400-540', '540-760', '760+'],
        limits: [280, 400, 540, 760],
    },
    /** Preview's tile area as a percent of the workspace's area. */
    previewShare: {
        labels: ['0-10', '10-25', '25-50', '50+'],
        limits: [10, 25, 50],
    },
} as const satisfies Record<string, Scale_>

/** The ranges numbers are sent as. Each list is in order, and each range's label is its value. */
export const scales = {
    counts: defined.counts.labels,
    audio: defined.audio.labels,
    size: defined.size.labels,
    quota: defined.quota.labels,
    usageShare: defined.usageShare.labels,
    viewport: defined.viewport.labels,
    viewportHeight: defined.viewportHeight.labels,
    viewportAspect: defined.viewportAspect.labels,
    dpr: defined.dpr.labels,
    noteSpeed: defined.noteSpeed.labels,
    peek: defined.peek.labels,
    frame: defined.frame.labels,
    slowEvent: defined.slowEvent.labels,
    cores: defined.cores.labels,
    dockSize: defined.dockSize.labels,
    previewShare: defined.previewShare.labels,
} as const

export type Scale = keyof typeof scales

declare const scaleBrand: unique symbol
/** A range label, made only by `bucket`, so a raw number or string cannot be sent as one. */
export type Bucket<S extends Scale> = (typeof scales)[S][number] & { readonly [scaleBrand]: S }

const within = (value: number, limit: Limit) =>
    typeof limit === 'number' ? value < limit : value <= limit.upTo

/** The range a number falls in. */
export const bucket = <S extends Scale>(scale: S, value: number): Bucket<S> => {
    const { labels, limits } = defined[scale]
    const at = limits.findIndex((limit) => within(value, limit))
    return labels[at < 0 ? labels.length - 1 : at] as Bucket<S>
}

/** The range of a measurement, or undefined when it is missing, not finite or negative. */
export const measured = <S extends Scale>(scale: S, value: number | undefined) =>
    value !== undefined && Number.isFinite(value) && value >= 0 ? bucket(scale, value) : undefined
