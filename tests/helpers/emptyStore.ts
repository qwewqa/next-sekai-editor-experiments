import { createState } from '../../src/state'

/** The store of a chart with nothing in it, for a fake state that still holds a chart's shape. */
export const emptyStore = createState(
    {
        initialLife: 1000,
        isDynamicStages: false,
        bpms: [],
        groups: new Map(),
        stages: new Map(),
        slides: [],
        timeScales: [],
        cameraEvents: [],
        stageMaskEvents: [],
        stagePivotEvents: [],
        stageStyleEvents: [],
        stageTransformEvents: [],
    },
    0,
).store
