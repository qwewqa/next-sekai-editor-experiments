import { readMeta, writeMeta } from './db'
import type { KvTx } from './kv/types'

// Strictly increasing time (Part 1 §1.6.8.7): now = max(Date.now(), meta.maxSeenTime + 1), and
// every write moves maxSeenTime, so two writes never share a time across tabs or a clock held back.

export const DAY_MS = 24 * 60 * 60 * 1000

/** The next time after maxSeenTime. */
export const nextTime = (maxSeenTime: number, wall: number) => Math.max(wall, maxSeenTime + 1)

/**
 * A time from outside this write (a journal, a file, a parent row) more than a day ahead of now is
 * clamped to now, so one wrong clock can't hold every later time at maxSeenTime + 1 for good.
 */
export const clampTime = (time: number, now: number) => (time > now + DAY_MS ? now : time)

/** Takes the next strictly increasing time inside a read-write transaction over `meta`. */
export const stampNow = async (tx: KvTx, wall: number = Date.now()) => {
    const now = nextTime((await readMeta(tx, 'maxSeenTime')) ?? 0, wall)
    await writeMeta(tx, 'maxSeenTime', now)
    return now
}
