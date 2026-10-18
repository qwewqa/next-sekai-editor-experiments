import type { State } from '../../state'
import { hasSameChartData } from '../../state/data'

// "Changed" (Part 1 §1.3.4): the live state against the state at the file event, by chart data
// and the header fields, never bare `State` identity, which a selection change replaces.

const sameMedia = (a: { hash: string } | undefined, b: { hash: string } | undefined) =>
    a?.hash === b?.hash

/** Whether two states hold the same file content. */
export const sameFileContent = (a: State, b: State) =>
    a === b ||
    (hasSameChartData(a, b) &&
        a.initialLife === b.initialLife &&
        a.bgm.offset === b.bgm.offset &&
        sameMedia(a.bgm.meta, b.bgm.meta) &&
        (a.levelInfo === b.levelInfo ||
            JSON.stringify(a.levelInfo) === JSON.stringify(b.levelInfo)))
