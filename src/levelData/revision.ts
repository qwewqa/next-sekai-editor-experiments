import type { LevelDataEntity } from '@sonolus/core'
import Type from 'typebox'
import Value from 'typebox/value'
import type { Chart } from '../chart'
import { ImportRefusal } from '../chart/refusal'

type RevisionStep = {
    revision: number
    /** Whether the chart shows differently under this revision than the one before. */
    affects: (chart: Chart) => boolean
}

const revisionSteps: RevisionStep[] = [
    // Elevation is no longer scaled by stage tilt.
    { revision: 2, affects: (chart) => hasElevation(chart) },
]

export const LATEST_REVISION = Math.max(...revisionSteps.map(({ revision }) => revision))

const hasElevation = (chart: Chart) =>
    chart.slides.some((slide) => slide.some((note) => (note.elevation ?? 0) !== 0)) ||
    chart.stageTransformEvents.some((event) => event.elevation !== 0)

/** The engine revision level data was saved for; missing means revision 1. */
export const getLevelDataRevision = ([entity]: LevelDataEntity[]) => {
    // Read as the level data parser reads optional values, without loading the parser.
    if (entity?.archetype !== 'Initialization') return 1
    const data = entity.data.find((data) => data.name === 'revision')
    if (!data || !('value' in data)) return 1
    if (!Value.Check(Type.Number(), data.value)) throw new ImportRefusal('invalidValue', 'revision')
    return data.value
}

export type RevisionWarning = 'older' | 'newer'

/** Opening a chart from another revision warns only when the change can show. */
export const getRevisionWarning = (revision: number, chart: Chart): RevisionWarning | undefined => {
    if (revision > LATEST_REVISION) return 'newer'
    if (revisionSteps.some((step) => step.revision > revision && step.affects(chart)))
        return 'older'
}
