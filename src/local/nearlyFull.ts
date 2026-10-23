import { HIGH_SHARE, type Estimate } from './pressure'

// "Browser storage is almost full." (owner, 2026-10-23): at load, after GC and the cleanup under
// pressure, usage still above the cleanup threshold gets one load notice pointing at Local Data,
// where Delete Sessions… is. At most once per calendar day, so a reload does not repeat it.

export type NearlyFullDeps = {
    estimate: () => Promise<Estimate>
    /** Today's date as a key, in the page's zone. */
    today: () => string
    /** The day the notice last showed. */
    lastDay: () => string | undefined
    saveDay: (day: string) => void
    /** Adds the load notice. */
    notice: () => void
}

/** Whether usage is above the share cleanup works down from; false when the estimate does not tell. */
export const isNearlyFull = ({ usage, quota }: Estimate) =>
    usage !== undefined && quota !== undefined && quota > 0 && usage > HIGH_SHARE * quota

/** Adds the notice when storage is still nearly full and today's has not been said; true when added. */
export const noticeIfNearlyFull = async (deps: NearlyFullDeps) => {
    const estimate = await deps.estimate().catch((): Estimate => ({}))
    if (!isNearlyFull(estimate)) return false
    const today = deps.today()
    if (deps.lastDay() === today) return false
    deps.saveDay(today)
    deps.notice()
    return true
}
