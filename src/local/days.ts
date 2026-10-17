import { readMeta, writeMeta } from './db'
import type { KvTx } from './kv/types'

// Days of use (Part 1 §1.6.8.7): `meta.daysOfUse` goes up by one at most once per calendar day,
// the local date of monotonic `now`, on which the editor is used. Rows stamp `day` with it, and
// "within the past N days" means `daysOfUse - day < N`, so a clock that jumps can't expire
// anything early.

/** The local date of a time, `YYYY-MM-DD`. */
export const localDate = (time: number) => {
    const date = new Date(time)
    const pad = (value: number) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Counts `now`'s day as a day of use once, inside a read-write transaction over `meta`; returns
 * the day rows written now are stamped with. A `now` dated before the last day counted (a clock
 * set back) counts nothing until the clock passes it again.
 */
export const countDayOfUse = async (tx: KvTx, now: number) => {
    const days = (await readMeta(tx, 'daysOfUse')) ?? 0
    const last = (await readMeta(tx, 'lastUseDate')) ?? ''
    const today = localDate(now)
    if (today <= last) return days
    await writeMeta(tx, 'daysOfUse', days + 1)
    await writeMeta(tx, 'lastUseDate', today)
    return days + 1
}
