// The lock a write to Export's remembered target runs under (§1.6.6). A picked file is written under
// the pick session's hold instead (`src/editor/save/pickSession.ts`).

type TargetLock = <T>(run: () => Promise<T>) => Promise<T>

let targetLock: TargetLock | undefined

/** Set by the Save core: `nse-bind` shared, held across a write to the remembered target. */
export const setTargetLock = (lock: TargetLock) => {
    targetLock = lock
}

/** Runs a write to the remembered target under the Save core's lock, when there is one. */
export const withTargetLock: TargetLock = (run) => (targetLock ? targetLock(run) : run())
