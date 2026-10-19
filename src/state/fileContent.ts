import type { State } from '.'
import { hasSameChartData } from './data'

// File content excludes selection and matching-media audio caches.
const sameMedia = (a: { hash: string } | undefined, b: { hash: string } | undefined) =>
    a?.hash === b?.hash

/** Compares file content in structurally shared editor states. */
export const sameFileContent = (a: State, b: State) =>
    a === b ||
    (hasSameChartData(a, b) &&
        a.initialLife === b.initialLife &&
        a.bgm.offset === b.bgm.offset &&
        sameMedia(a.bgm.meta, b.bgm.meta) &&
        (a.levelInfo === b.levelInfo ||
            JSON.stringify(a.levelInfo) === JSON.stringify(b.levelInfo)))
