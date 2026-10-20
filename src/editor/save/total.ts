import type { SaveSizeEstimate } from '../../local/save/estimate'

/**
 * The Save dialog's total for the ticks answered: the base and the ticked rows. Undefined when a
 * ticked row's size is unknown (a BGM whose media row is damaged), so no total is shown as final:
 * a size that is unknown is never counted as 0.
 */
export const totalOf = (
    estimate: Pick<SaveSizeEstimate, 'base' | 'history' | 'bgm'>,
    ticks: { history: boolean; bgm: boolean },
) => {
    if (ticks.bgm && estimate.bgm === undefined) return
    return (
        estimate.base + (ticks.history ? estimate.history : 0) + (ticks.bgm ? estimate.bgm! : 0)
    )
}
