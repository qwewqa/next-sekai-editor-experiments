import type { LevelDataEntity } from '@sonolus/core'
import type { Chart } from '../chart'

type RevisionStep = {
    revision: number
    /** Whether the chart plays or shows differently under this revision than the one before. */
    affects: (chart: Chart) => boolean
}

const revisionSteps: RevisionStep[] = [
    // Below revision 1 the engine scores by unweighted combo.
    { revision: 1, affects: () => true },
    // Elevation is no longer scaled by stage tilt.
    { revision: 2, affects: (chart) => hasElevation(chart) },
]

export const LATEST_REVISION = Math.max(...revisionSteps.map(({ revision }) => revision))

const hasElevation = (chart: Chart) =>
    chart.slides.some((slide) => slide.some((note) => (note.elevation ?? 0) !== 0)) ||
    chart.stageTransformEvents.some((event) => event.elevation !== 0)

/** The engine revision level data was saved for; missing means revision 1. */
export const getLevelDataRevision = ([entity]: readonly LevelDataEntity[]) => {
    // Read as the level data parser reads optional values, without loading the parser.
    if (entity?.archetype !== 'Initialization') return 1
    const data = entity.data.find((data) => data.name === 'revision')
    if (!data || !('value' in data)) return 1
    return data.value
}

export type RevisionWarning = 'older' | 'newer'

/** Opening a chart from another revision warns only when the change can matter. */
export const getRevisionWarning = (revision: number, chart: Chart): RevisionWarning | undefined => {
    if (revision > LATEST_REVISION) return 'newer'
    if (revisionSteps.some((step) => step.revision > revision && step.affects(chart)))
        return 'older'
}
