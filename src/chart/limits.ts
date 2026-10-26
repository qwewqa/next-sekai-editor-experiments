/**
 * The largest coordinates a chart may hold. The grid keeps a bucket for each beat a connector
 * spans, and the preview a slot lane for each lane of a note’s width, so values past these would
 * hang or exhaust memory.
 */
export const maxBeat = 100000
export const maxLane = 5000
export const maxSize = 5000
/** Bars walk the grid one at a time, so a bar must neither be tiny nor outlast the chart. */
export const minMeter = 1 / 16
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
    meter: [minMeter, maxMeter],
}

/** Whether a field's value is within its limit; fields without one always are. */
export const isWithinLimit = (name: string, value: number) => {
    const limit = fieldLimits[name]
    return !limit || (value >= limit[0] && value <= limit[1])
}

/** The first bounded field of a chart object or entity that is past its limit. */
export const fieldPastLimit = (object: object): string | undefined => {
    for (const [name, value] of Object.entries(object))
        if (typeof value === 'number' && !isWithinLimit(name, value)) return name
}
