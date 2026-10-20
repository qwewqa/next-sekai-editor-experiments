import { getCurrentScope, onScopeDispose, shallowRef, type ShallowRef } from 'vue'
import {
    dayKey,
    hostZone,
    nextBoundary,
    spanKey,
    type DayKey,
    type SpanKey,
    type Zone,
} from '../../calendar/calendar'

// The History clock (Part 1 §1.4.10.5): the one time and time zone every History surface draws
// from, sampled once. A `Calendar` changes only when the local hour (so the day) changes or the
// zone does, so a rebuild happens at those moments and no other. The clock looks at the boundary
// it armed, every minute while anything is subscribed (a sleeping laptop wakes late, and a zone
// changes silently), whenever History or Go To opens, and when the tab is shown or focused.

export type Calendar = {
    readonly now: number
    readonly zone: Zone
    readonly today: DayKey
    readonly span: SpanKey
}

export const calendarAt = (now: number, zone: Zone): Calendar => ({
    now,
    zone,
    today: dayKey(now, zone),
    span: spanKey(now, zone),
})

const CHECK_EVERY = 60_000
const MAX_TIMER = 2 ** 31 - 1

const published = shallowRef<Calendar>(calendarAt(Date.now(), hostZone()))
let subscribers = 0
let timer: ReturnType<typeof setTimeout> | undefined
let interval: ReturnType<typeof setInterval> | undefined
let listening = false

const arm = (calendar: Calendar) => {
    clearTimeout(timer)
    // The hour's start itself, or a moment before it if the timer is early: that check finds
    // the same hour and arms the rest.
    const delay = nextBoundary(calendar.now, calendar.zone) - calendar.now
    timer = setTimeout(check, Math.min(MAX_TIMER, Math.max(1, delay)))
}

/** Looks at the clock and the zone now; publishes a new calendar if the hour or the zone moved. */
const check = () => {
    if (subscribers === 0) return
    const now = Date.now()
    const zone = hostZone()
    const current = published.value
    if (zone !== current.zone || spanKey(now, zone) !== current.span) {
        published.value = calendarAt(now, zone)
        arm(published.value)
    } else {
        // Same hour: keep the calendar, and arm from the real time so a late or early timer
        // cannot drift.
        arm(calendarAt(now, zone))
    }
}

const onVisible = () => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') check()
}

const listen = (add: boolean) => {
    if (typeof window === 'undefined') return
    const toggle = (target: EventTarget, type: string, handler: () => void) => {
        if (add) target.addEventListener(type, handler)
        else target.removeEventListener(type, handler)
    }
    toggle(window, 'focus', check)
    toggle(window, 'pageshow', check)
    if (typeof document !== 'undefined') toggle(document, 'visibilitychange', onVisible)
}

const subscribe = () => {
    if (subscribers++ > 0) return
    published.value = calendarAt(Date.now(), hostZone())
    arm(published.value)
    interval = setInterval(check, CHECK_EVERY)
    if (!listening) listen((listening = true))
}

const unsubscribe = () => {
    if (--subscribers > 0) return
    subscribers = 0
    clearTimeout(timer)
    clearInterval(interval)
    timer = interval = undefined
    if (listening) listen((listening = false))
}

/** Subscribes the caller until it calls the returned function. */
export const subscribeHistoryCalendar = (): (() => void) => {
    subscribe()
    let done = false
    return () => {
        if (done) return
        done = true
        unsubscribe()
    }
}

/**
 * The History calendar, kept current for the effect scope that asks (a component's setup).
 * The same value for every surface: one clock per History view (I-1).
 */
export const useHistoryCalendar = (): Readonly<ShallowRef<Calendar>> => {
    const release = subscribeHistoryCalendar()
    if (getCurrentScope()) onScopeDispose(release)
    return published
}

/**
 * The calendar for a caller with no scope (Restore's notice): the published one while the clock
 * runs, else a fresh sample that publishes nothing.
 */
export const historyCalendar = (): Calendar => {
    // Read either way, so a computed that asks while idle sees the clock start.
    const current = published.value
    return subscribers > 0 ? current : calendarAt(Date.now(), hostZone())
}

/** Looks at the clock now, when History or Go To opens. Does nothing while no surface is subscribed. */
export const checkHistoryCalendar = () => {
    check()
}
