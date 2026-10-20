// The one calendar (Part 1 §1.6.8.7): local days, hours and minutes of a time in an explicit time
// zone. Pure: nothing here reads the clock or the host's zone except `hostZone`, which the History
// clock and days of use call. Every function returns a value for any number (clamped into
// [0, TIME_LIMIT]) and any zone (a name the engine rejects is UTC), so no surface fails to draw
// because of a time.

export type Zone = string & { readonly __zone: true }
/** A local date as a whole number of days since 1970-01-01 (the date the clock shows). */
export type DayKey = number & { readonly __dayKey: true }
/** The instant the clock last showed :00 for the hour a time is in. */
export type HourKey = number & { readonly __hourKey: true }
/** A local day and hour together: what a ×N group stays inside (X-1). */
export type SpanKey = string & { readonly __spanKey: true }

/** The latest time a `Date` can hold, in ms. */
export const TIME_LIMIT = 8.64e15

const DAY = 86_400_000
const HOUR = 3_600_000
const MINUTE = 60_000

/** Any number into [0, TIME_LIMIT]; NaN is 0. */
export const clampToDomain = (time: number) =>
    Number.isNaN(time) ? 0 : Math.min(TIME_LIMIT, Math.max(0, time))

const UTC = 'UTC' as Zone
const zones = new Map<string, Zone>()

/** The zone a name stands for, or UTC when the engine accepts no zone by that name. */
export const resolveZone = (name: unknown): Zone => {
    if (typeof name !== 'string') return UTC
    const known = zones.get(name)
    if (known) return known
    let zone = UTC
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: name })
        zone = name as Zone
    } catch {
        // Rejected: UTC.
    }
    // The cache holds only what a caller can name; a stream of bad names must not grow it.
    if (zones.size < 512) zones.set(name, zone)
    return zone
}

/** The engine's zone now. Read fresh on every call: it changes when the user moves or travels. */
export const hostZone = (): Zone =>
    resolveZone(new Intl.DateTimeFormat().resolvedOptions().timeZone)

export type LocalFields = {
    year: number
    month: number
    day: number
    hour: number
    minute: number
    second: number
    ms: number
}

type Zoned = {
    format: Intl.DateTimeFormat
    /** Local year, month, day, hour and minute of a UTC minute whose every instant agrees. */
    minutes: Map<number, readonly [number, number, number, number, number]>
}

const zoned = new Map<Zone, Zoned>()
const MEMO_LIMIT = 4096

const zonedOf = (zone: Zone) => {
    let found = zoned.get(zone)
    if (!found) {
        found = {
            format: new Intl.DateTimeFormat('en-US', {
                timeZone: zone,
                calendar: 'gregory',
                numberingSystem: 'latn',
                hourCycle: 'h23',
                year: 'numeric',
                month: 'numeric',
                day: 'numeric',
                hour: 'numeric',
                minute: 'numeric',
                second: 'numeric',
            }),
            minutes: new Map(),
        }
        zoned.set(zone, found)
    }
    return found
}

type Parts = [
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
]

const PART_INDEX: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {
    year: 0,
    month: 1,
    day: 2,
    hour: 3,
    minute: 4,
    second: 5,
}

const partsAt = (zone: Zoned, time: number): Parts => {
    const parts: Parts = [1970, 1, 1, 0, 0, 0]
    for (const { type, value } of zone.format.formatToParts(time)) {
        const index = PART_INDEX[type]
        if (index !== undefined) parts[index] = Number(value)
    }
    // The clock can read 24 for midnight; hour cycle h23 should not, but the engine decides.
    parts[3] %= 24
    return parts
}

// A UTC minute can be shared by every instant in it only when the clock's seconds follow UTC's
// across it: Monrovia before 1972 was 44 minutes 30 seconds behind, so its minutes are formatted
// to the second, and are not shared.
const sharedMinute = (zone: Zoned, minute: number): Parts | undefined => {
    // The last minute of the domain has instants past it.
    if (minute * MINUTE + MINUTE - 1 > TIME_LIMIT) return undefined
    const start = partsAt(zone, minute * MINUTE)
    if (start[5] !== 0) return undefined
    const end = partsAt(zone, minute * MINUTE + MINUTE - 1)
    for (let i = 0; i < 5; i++) if (start[i] !== end[i]) return undefined
    return end[5] === 59 ? start : undefined
}

/** The clock's fields for a time in a zone. */
export const fieldsOf = (time: number, zone: Zone): LocalFields => {
    const t = Math.floor(clampToDomain(time))
    const minute = Math.floor(t / MINUTE)
    const within = t - minute * MINUTE
    const where = zonedOf(zone)
    let shared = where.minutes.get(minute)
    if (!shared) {
        const found = sharedMinute(where, minute)
        if (found) {
            if (where.minutes.size >= MEMO_LIMIT) where.minutes.clear()
            shared = [found[0], found[1], found[2], found[3], found[4]]
            where.minutes.set(minute, shared)
        }
    }
    if (shared)
        return {
            year: shared[0],
            month: shared[1],
            day: shared[2],
            hour: shared[3],
            minute: shared[4],
            second: Math.floor(within / 1000),
            ms: within % 1000,
        }
    const [year, month, day, hour, minuteOfHour, second] = partsAt(where, t)
    return { year, month, day, hour, minute: minuteOfHour, second, ms: t % 1000 }
}

const withinHour = (fields: LocalFields) =>
    fields.minute * MINUTE + fields.second * 1000 + fields.ms

/** The local date a time falls on. */
export const dayKey = (time: number, zone: Zone): DayKey => {
    const { year, month, day } = fieldsOf(time, zone)
    return (Date.UTC(year, month - 1, day) / DAY) as DayKey
}

// The start of the local hour: the minutes the clock shows are taken away, rather than the time
// rounded, because at a fall-back "1:00" names two instants an hour apart (and a zone can be
// minutes and seconds off the hour in UTC).
/** The start of the local hour a time falls in. */
export const hourKey = (time: number, zone: Zone): HourKey =>
    (Math.floor(clampToDomain(time)) - withinHour(fieldsOf(time, zone))) as HourKey

/** The local minute a time falls in, as whole minutes since 1970 in UTC at the minute's start. */
export const minuteKey = (time: number, zone: Zone) => {
    const fields = fieldsOf(time, zone)
    return Math.floor((Math.floor(clampToDomain(time)) - fields.second * 1000 - fields.ms) / MINUTE)
}

/** The day and hour together. A ×N group never crosses one (X-1). */
export const spanKey = (time: number, zone: Zone): SpanKey => {
    const fields = fieldsOf(time, zone)
    const day = Date.UTC(fields.year, fields.month - 1, fields.day) / DAY
    return `${day}|${Math.floor(clampToDomain(time)) - withinHour(fields)}` as SpanKey
}

/** Whole days from one date to a later one (negative when earlier). */
export const daysBetween = (from: DayKey, to: DayKey) => to - from

export const sameDay = (a: number, b: number, zone: Zone) => dayKey(a, zone) === dayKey(b, zone)

export const sameYear = (a: number, b: number, zone: Zone) =>
    fieldsOf(a, zone).year === fieldsOf(b, zone).year

/** The year of a local date. */
export const yearOfDay = (day: DayKey) => new Date(day * DAY).getUTCFullYear()

/** The instant of UTC noon on a local date: a time that formats, in UTC, as that date. */
export const dayNoon = (day: DayKey) => clampToDomain(day * DAY + 12 * HOUR)

/**
 * The first instant after `time` where the hour changes (and so the day, whose change is always
 * one of an hour). A time at the end of the domain is its own next boundary.
 */
export const nextBoundary = (time: number, zone: Zone): number => {
    const t = Math.floor(clampToDomain(time))
    if (t >= TIME_LIMIT) return TIME_LIMIT
    const current = hourKey(t, zone)
    // The usual hour is 60 minutes: the next one starts an hour after this one did.
    const usual = current + HOUR
    if (
        usual > t &&
        usual <= TIME_LIMIT &&
        hourKey(usual, zone) !== current &&
        hourKey(usual - 1, zone) === current
    )
        return usual
    // Otherwise (a clock change, a zone off the hour) the keys never decrease, so look for the
    // first change by doubling and then halving.
    let low = t
    let step = HOUR
    let high = Math.min(TIME_LIMIT, t + step)
    while (high < TIME_LIMIT && hourKey(high, zone) === current) {
        low = high
        step *= 2
        high = Math.min(TIME_LIMIT, high + step)
    }
    if (hourKey(high, zone) === current) return TIME_LIMIT
    while (high - low > 1) {
        const middle = Math.floor((low + high) / 2)
        if (hourKey(middle, zone) === current) low = middle
        else high = middle
    }
    return high
}

/** The local date as "2026-10-20": a stable text to compare and store. */
export const dateText = (time: number, zone: Zone) => {
    const { year, month, day } = fieldsOf(time, zone)
    const pad = (value: number, size = 2) => String(value).padStart(size, '0')
    return `${pad(year, 4)}-${pad(month)}-${pad(day)}`
}
