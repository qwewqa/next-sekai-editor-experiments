import type { Chart } from '.'

/**
 * The largest coordinates a chart may hold. The grid keeps a bucket for each beat a connector
 * spans, and the preview a slot lane for each lane of a note’s width, so values past these would
 * hang or exhaust memory.
 */
export const maxBeat = 100000
export const maxLane = 5000
export const maxSize = 5000
/** A bar longer than the chart stalls the grid searches. */
export const maxMeter = maxBeat

/** The range of each bounded field of a chart object or entity. */
const fieldLimits: Record<string, readonly [min: number, max: number]> = {
    beat: [0, maxBeat],
    yOffsetBeat: [-maxBeat, maxBeat],
    left: [-maxLane, maxLane],
    cameraLeft: [-maxLane, maxLane],
    maskLeft: [-maxLane, maxLane],
    pivotLane: [-maxLane, maxLane],
    cameraZoomTargetLane: [-maxLane, maxLane],
    size: [0, maxSize],
    cameraSize: [0, maxSize],
    maskSize: [0, maxSize],
    // Above 0.
    meter: [Number.MIN_VALUE, maxMeter],
}

/** Whether a field's value is within its limit; fields without one always are. */
export const isWithinLimit = (name: string, value: number) => {
    const limit = fieldLimits[name]
    return !limit || (value >= limit[0] && value <= limit[1])
}

const limited = Object.entries(fieldLimits)

/** The first bounded field of a chart object or entity that is past its limit. */
export const fieldPastLimit = (object: object): string | undefined => {
    for (const [name, [min, max]] of limited) {
        const value = (object as Record<string, unknown>)[name]
        if (typeof value === 'number' && !(value >= min && value <= max)) return name
    }
}

/** Every object of a chart that has a beat. */
export const chartObjects = (chart: Chart) => [
    ...chart.bpms,
    ...chart.timeScales,
    ...chart.cameraEvents,
    ...chart.stageMaskEvents,
    ...chart.stagePivotEvents,
    ...chart.stageStyleEvents,
    ...chart.stageTransformEvents,
    ...chart.slides.flat(),
]

/** Throws for a chart with a coordinate past its limit, as a snapshot's records are checked. */
export const assertWithinLimits = (chart: Chart) => {
    for (const object of chartObjects(chart)) {
        const name = fieldPastLimit(object)
        if (name) throw new Error(`The chart's ${name} is past its limit`)
    }
}
