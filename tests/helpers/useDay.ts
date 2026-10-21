import type { UseDay } from '../../src/local/days'

/** A day of use for a test: the `UseDay` brand is made in the source only by `countDayOfUse`. */
export const useDay = (n: number) => n as UseDay
