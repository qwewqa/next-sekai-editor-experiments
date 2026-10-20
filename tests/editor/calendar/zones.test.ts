import assert from 'node:assert/strict'
import test from 'node:test'
import {
    dayKey,
    fieldsOf,
    hourKey,
    nextBoundary,
    resolveZone,
    type Zone,
} from '../../../src/calendar/calendar'

// I-8 and I-7: in every zone the runtime knows, from 2011 on, the day and hour keys never
// decrease along time, an hour starts at or before the time, and `nextBoundary` is the first
// change. The scan looks at every zone weekly, finds each place the zone's offset moves, and
// looks at that place minute by minute. NSE_CALENDAR_FULL=1 scans every year from 1970 to 2100.

const MINUTE = 60_000
const HOUR = 3_600_000
const WEEK = 7 * 24 * HOUR
const full = process.env.NSE_CALENDAR_FULL === '1'

const names = Intl.supportedValuesOf('timeZone')

/** The wall clock's reading less the UTC time: the zone's offset in ms. */
const offsetOf = (time: number, zone: Zone) => {
    const f = fieldsOf(time, zone)
    return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second, f.ms) - time
}

/** The first instant at which the offset is not `before`'s, between `low` (has it) and `high`. */
const transitionIn = (low: number, high: number, zone: Zone) => {
    const was = offsetOf(low, zone)
    while (high - low > 1) {
        const middle = Math.floor((low + high) / 2)
        if (offsetOf(middle, zone) === was) low = middle
        else high = middle
    }
    return high
}

type Breach = { zone: string; time: string; what: string }

/** The places scanned, so a scan that looks at nothing is told. */
const looked = { windows: 0, zones: new Set<string>() }

const scan = (zone: Zone, years: Iterable<number>) => {
    const breaches: Breach[] = []
    const note = (time: number, what: string) =>
        breaches.push({ zone, time: new Date(time).toISOString(), what })
    for (const year of years) {
        // Weekly, a week before the year to a week past it: keys never decrease.
        let weekDay: number | undefined
        let weekHour: number | undefined
        let weekOffset: number | undefined
        const end = Date.UTC(year + 1, 0, 1) + WEEK
        for (let t = Math.max(0, Date.UTC(year, 0, 1) - WEEK); t < end; t += WEEK) {
            const day = dayKey(t, zone)
            const hour = hourKey(t, zone)
            if (weekDay !== undefined && (day < weekDay || hour < weekHour!))
                note(t, 'weekly keys decrease')
            if (hour > t) note(t, 'hour key after the time')
            const offset = offsetOf(t, zone)
            if (weekOffset !== undefined && offset !== weekOffset) {
                // The offset moved in the week before: look at the move.
                const moved = transitionIn(t - WEEK, t, zone)
                window(moved)
            }
            weekDay = day
            weekHour = hour
            weekOffset = offset
        }
    }
    function window(moved: number) {
        looked.windows++
        looked.zones.add(zone)
        const start = Math.floor(moved / MINUTE) * MINUTE - 100 * MINUTE
        let previousDay: number | undefined
        let previousHour: number | undefined
        const samples: number[] = []
        for (let t = start; t <= start + 200 * MINUTE; t += MINUTE) {
            const day = dayKey(t, zone)
            const hour = hourKey(t, zone)
            if (previousDay !== undefined && (day < previousDay || hour < previousHour!))
                note(t, 'keys decrease')
            if (hour > t) note(t, 'hour key after the time')
            previousDay = day
            previousHour = hour
            samples.push(t)
        }
        // `nextBoundary` is the first change: the key at it differs, and one ms before it does not.
        for (let i = 0; i < samples.length - 1; i += 6) {
            const t = samples[i]! + 17_000
            const boundary = nextBoundary(t, zone)
            const current = hourKey(t, zone)
            if (!(boundary > t)) note(t, 'next boundary not after the time')
            else if (hourKey(boundary, zone) === current) note(t, 'no change at the next boundary')
            else if (hourKey(boundary - 1, zone) !== current)
                note(t, 'change before the next boundary')
        }
    }
    return breaches
}

const sampledYears = () => {
    // Every third year, the year Venezuela moved its clock by 30 minutes, and this year and the next.
    const years: number[] = []
    for (let year = 2011; year <= 2040; year += 3) years.push(year)
    return [...years, 2016, 2026, 2027]
}

const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i)

/**
 * Breaches before 2011, by zone: the first and last year of the allow-list. Goose Bay and Moncton
 * are the design's (Newfoundland and New Brunswick moved their clocks at 00:01, across midnight);
 * St. John's moved the same way as Goose Bay, and Casey once, which the 1970–2100 sweep found.
 */
const ALLOWED: Record<string, readonly [from: string, to: string]> = {
    'America/Goose_Bay': ['1987', '2010-12'],
    'America/Moncton': ['1993', '2006-12'],
    'America/St_Johns': ['1987', '2010-12'],
    'Antarctica/Casey': ['2010-03', '2010-04'],
}

const allowed = (breach: Breach) => {
    const range = ALLOWED[breach.zone]
    return range !== undefined && breach.time >= range[0] && breach.time < range[1] + '-32'
}

test(`no zone steps its keys back or leaves its hour ${full ? '(1970–2100)' : '(sampled 2011–2040)'}`, () => {
    const breaches: Breach[] = []
    const years = full ? range(1970, 2100) : sampledYears()
    for (const name of [...names, 'UTC'])
        breaches.push(...scan(resolveZone(name), years).filter((breach) => !allowed(breach)))
    assert.deepEqual(breaches.slice(0, 5), [])
    // About two moves a year in the zones that have daylight saving time, every one looked at.
    assert.ok(looked.windows > 3000, `${looked.windows} windows`)
    assert.ok(looked.zones.size > 150, `${looked.zones.size} zones moved`)
})

test('the allow-list: Goose Bay (1987–2010) and Moncton (1993–2006) breach, and only inside their years', () => {
    const goose = scan(resolveZone('America/Goose_Bay'), range(1987, 2010))
    const moncton = scan(resolveZone('America/Moncton'), range(1993, 2006))
    // They are real: without the allow-list, the scan finds them (so the list is not stale).
    assert.ok(goose.length > 0, 'Goose Bay does not breach')
    assert.ok(moncton.length > 0, 'Moncton does not breach')
    for (const breach of [...goose, ...moncton]) assert.ok(allowed(breach), breach.time)
    // Outside those years both zones are clean, and so is every year from 2011 on.
    assert.deepEqual(scan(resolveZone('America/Goose_Bay'), range(2011, 2030)), [])
    assert.deepEqual(scan(resolveZone('America/Moncton'), range(2007, 2030)), [])
    for (const name of ['America/St_Johns', 'Antarctica/Casey'])
        assert.deepEqual(scan(resolveZone(name), range(2011, 2030)), [], name)
})

test('the engine knows the zones this file scans', () => {
    assert.ok(names.length > 300)
    assert.ok(names.includes('America/New_York'))
})

test('an hour that is not 60 minutes long ends where the clock moves, not an hour on', () => {
    // Venezuela moved its clock by 30 minutes on 2016-05-01: 02:30 (UTC-4:30) became 03:00 (UTC-4).
    // The 2 AM hour lasted 30 minutes, and the next hour started at 06:30Z, not at 07:00Z.
    const caracas = resolveZone('America/Caracas')
    const start = Date.UTC(2016, 4, 1, 6, 10) // 02:10 in Caracas
    assert.equal(nextBoundary(start, caracas), Date.UTC(2016, 4, 1, 6, 30))
    assert.equal(hourKey(Date.UTC(2016, 4, 1, 6, 30), caracas), Date.UTC(2016, 4, 1, 6, 30))
    // After the move the hours are whole again, and a boundary is the hour on.
    assert.equal(nextBoundary(Date.UTC(2016, 4, 1, 6, 30), caracas), Date.UTC(2016, 4, 1, 7, 0))
    // Lord Howe's half-hour of daylight saving time (the clock goes back 30 minutes on 2026-04-05).
    const lordHowe = resolveZone('Australia/Lord_Howe')
    for (let t = Date.UTC(2026, 3, 4, 13); t < Date.UTC(2026, 3, 4, 17); t += 7 * MINUTE) {
        const boundary = nextBoundary(t, lordHowe)
        const current = hourKey(t, lordHowe)
        assert.ok(boundary > t && boundary <= t + HOUR, `after ${t}`)
        assert.notEqual(hourKey(boundary, lordHowe), current)
        assert.equal(hourKey(boundary - 1, lordHowe), current)
    }
})
