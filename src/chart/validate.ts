import type { Chart } from '.'
import { fieldPastLimit, isWithinLimit } from './limits'
import { ImportRefusal } from './refusal'

export const validateChart = (chart: Chart) => {
    if (!chart.bpms.some(({ beat }) => beat === 0)) throw new ImportRefusal('initialBpm')

    validateValues(chart)
}

const objectsOf = (chart: Chart) => [
    ...chart.bpms,
    ...chart.timeScales,
    ...chart.cameraEvents,
    ...chart.stageMaskEvents,
    ...chart.stagePivotEvents,
    ...chart.stageStyleEvents,
    ...chart.stageTransformEvents,
    ...chart.slides.flat(),
]

/** Refuses a coordinate past its limit, as a stored snapshot is checked when it is built. */
export const validateLimits = (chart: Chart) => {
    for (const object of objectsOf(chart)) {
        const name = fieldPastLimit(object)
        if (name) throw new ImportRefusal('invalidValue', name)
    }
}

/** The checks that also apply to a part of a chart, such as a copy. */
export const validateValues = (chart: Chart) => {
    // Level data refuses these, so the editor could not reopen its own file.
    const notes = chart.slides.flat()
    const objects = objectsOf(chart)
    if (objects.some(({ beat }) => beat < 0)) throw new ImportRefusal('negativeBeat')
    if (notes.some(({ size }) => size < 0)) throw new ImportRefusal('negativeNoteSize')
    if (chart.bpms.some(({ bpm }) => !(bpm > 0 && Number.isFinite(bpm))))
        throw new ImportRefusal('invalidBpm')
    // NaN and infinities save as null.
    for (const object of objects) {
        for (const [name, value] of Object.entries(object)) {
            if (typeof value !== 'number') continue
            if (!Number.isFinite(value) || !isWithinLimit(name, value))
                throw new ImportRefusal('invalidValue', name)
        }
    }
}
