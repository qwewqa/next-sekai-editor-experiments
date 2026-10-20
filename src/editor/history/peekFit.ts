import { shallowRef } from 'vue'
import { formatClockSeconds, formatDateTimeSeconds } from '../../i18n/dateTime'
import { languageTag } from '../../i18n/plural'

// The peek strip's fit (Part 1 §1.4.11): one width per language and width class, from the widest
// text the strip can show, measured once, never from the live date. Stepping between entries or
// across midnight never resizes the stack, so the change arrows below never move.

/** The widest texts, in px at the strip's 14 px, normal weight, tabular figures. */
export type PeekWidths = {
    /** A clock with seconds: an entry from today. */
    today: number
    /** A date and time with seconds this year, or the compact form: an earlier entry. */
    earlier: number
    /** The compact date and time: earlier entries in narrow panes, and other years. */
    compact: number
    back: number
    restore: number
    /** The corner time labels' widest forms at 16 px, with their 4 px inset and 8 px clearance. */
    labels: number
    /**
     * The capsule's widest fixed line at its 12 px (changes.ts `fixedLines`): the passive ones, short
     * under 480 px panes and long from 480, and the summary button's at every width, counted 14 px
     * wider (its pl-2, gap-1, 12 px chevron and pr-1.5 against the passive line's px-2).
     */
    states: number
    statesWide: number
    /** The root font size the widths were measured at: the layout’s fixed sizes scale with it. */
    rem: number
}

export type PeekLayout = {
    width: number
    back: 'label' | 'icon'
    /**
     * The date button shows only its glyph: under 300 px panes, and wherever the whole date would not
     * fit even beside Back to Now’s chevron. The date is never cut to an ambiguous time.
     */
    tiny: boolean
    /** Under 340 px panes: Restore takes 12 px padding. */
    snug: boolean
    /** From 480 px panes: earlier dates take their long form. */
    wide: boolean
    inset: 'pt-2' | 'pt-7'
    /** Restore keeps its whole label; else, in the tiniest panes, it truncates last. */
    restoreFits: boolean
    /**
     * The change capsule (the strip less 12 px) shows the options button in place of the eye and the
     * summary: under 320 px panes, and wherever the eye, the widest state line and both arrows would
     * not fit in it. Else the strip widens for them where the pane has room, unless it is tiny.
     */
    compact: boolean
    /** The arrows narrow to 44 px: under 180 px panes, or wherever the compact row would not fit. */
    narrowArrows: boolean
}

export const compactDateTime = (locale: string) =>
    new Intl.DateTimeFormat(languageTag(locale), {
        year: '2-digit',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    })

/** Every month name and day period, one- and two-digit hours: tabular figures make digits equal. */
const candidates = (year: number) =>
    Array.from({ length: 12 }, (_, month) =>
        [0, 1, 9, 10, 11, 12, 13, 21, 22, 23].map((hour) =>
            new Date(year, month, 28, hour, 58, 58).getTime(),
        ),
    ).flat()

const BEAT_SAMPLES = { beat: '000.000', measure: '000.0.000', both: '000.0.000 (000.000)' }

export const measurePeekWidths = (
    host: HTMLElement,
    locale: string,
    beatDisplay: keyof typeof BEAT_SAMPLES,
    labels: {
        back: string
        restore: string
        states: string[]
        statesWide: string[]
        summary: string[]
    },
    now = Date.now(),
): PeekWidths => {
    const box = document.createElement('div')
    box.setAttribute('aria-hidden', 'true')
    box.style.cssText =
        'position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;white-space:nowrap;font-weight:400;font-variant-numeric:tabular-nums'
    const spans = (texts: string[], size: number) =>
        texts.map((text) => {
            const span = document.createElement('span')
            span.style.cssText = `position:absolute;font-size:${size / 16}rem`
            span.textContent = text
            box.append(span)
            return span
        })
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    const times = candidates(new Date(now).getFullYear())
    const compact = compactDateTime(locale)
    const today = spans(
        times.map((at) => formatClockSeconds(locale, at)),
        14,
    )
    const thisYear = spans(
        times.map((at) => formatDateTimeSeconds(locale, at, now)),
        14,
    )
    const compactSpans = spans(
        times.map((at) => compact.format(at)),
        14,
    )
    const backSpans = spans([labels.back], 14)
    const restoreSpans = spans([labels.restore], 14)
    const corner = spans(['00:00.000', BEAT_SAMPLES[beatDisplay]], 16)
    const states = spans(labels.states, 12)
    const statesWide = spans(labels.statesWide, 12)
    const summary = spans(labels.summary, 12)
    host.append(box)
    // One layout pass reads them all.
    const widest = (list: HTMLElement[]) =>
        Math.max(0, ...list.map((s) => s.getBoundingClientRect().width))
    const compactW = widest(compactSpans)
    const summaryW = labels.summary.length ? widest(summary) + (14 / 16) * rem : 0
    const widths = {
        today: widest(today),
        earlier: Math.max(widest(thisYear), compactW),
        compact: compactW,
        back: widest(backSpans),
        restore: widest(restoreSpans),
        labels: widest(corner) + ((4 + 8) / 16) * rem,
        states: Math.max(widest(states), summaryW),
        statesWide: Math.max(widest(statesWide), summaryW),
        rem,
    }
    box.remove()
    return widths
}

/** Measured on the strip's mount and on changes of language, beat display or fonts. */
export const peekWidths = shallowRef<PeekWidths>()

// The strip: p-1, the date button (pl-2.5, 16 px glyph, gap-2, text, pr-2.5), gap-2, Back to Now
// (px-4 label or a 36 px chevron), gap-2, Restore (px-4, or px-3 when snug), p-1. In px at the
// 16 px rem; k scales them with the root font size, as the classes do.
const DATE_BUTTON = 10 + 16 + 8 + 10
const ICON = 36

export const peekLayout = (pane: number, w: PeekWidths | undefined): PeekLayout => {
    const snug = pane < 340
    const wide = pane >= 480
    const k = (w?.rem ?? 16) / 16
    const avail = Math.min(pane - 16 * k, 480 * k)
    if (!w)
        return {
            width: avail,
            back: 'icon',
            tiny: pane < 300,
            snug,
            wide,
            inset: 'pt-7',
            restoreFits: true,
            compact: pane < 320,
            narrowArrows: pane < 180,
        }
    const date = wide ? Math.max(w.today, w.earlier) : Math.max(w.today, w.compact)
    const restore = (snug ? 24 : 32) * k + w.restore
    const strip = (dateButton: number, back: number) =>
        (4 + 8 + 8 + 4) * k + dateButton + back + restore
    const tiny = pane < 300 || strip(DATE_BUTTON * k + date, ICON * k) > avail
    let width: number
    let back: PeekLayout['back']
    if (tiny) {
        width = strip(ICON * k, ICON * k)
        back = 'icon'
    } else if (strip(DATE_BUTTON * k + date, 32 * k + w.back) <= avail) {
        width = strip(DATE_BUTTON * k + date, 32 * k + w.back)
        back = 'label'
    } else {
        width = strip(DATE_BUTTON * k + date, ICON * k)
        back = 'icon'
    }
    // Restore gives way last: only when the date has given way down to its glyph.
    const restoreFits = strip((tiny ? ICON : DATE_BUTTON) * k, ICON * k) <= avail
    width = Math.ceil(Math.min(width, avail))
    // The capsule's rows: p-1, the eye (24), gap-2, the summary (px-2 and its words, at least 32 px:
    // the widest fixed line), gap-2, the arrows (48 + 8 + 48), p-1. Where the strip is
    // narrower, it widens to hold them when the pane has room, so a state line never truncates; a tiny
    // strip keeps its size. Else compact puts the 24 px options button for the eye and summary, and
    // the menu shows the whole line; narrow arrows are 44 + 4 + 44.
    const row =
        (4 + 24 + 8 + 16 + 8 + 104 + 4) * k + Math.max(32 * k, wide ? w.statesWide : w.states)
    if (!tiny && pane >= 320 && width - 12 * k < row && row + 12 * k <= avail)
        width = Math.ceil(row + 12 * k)
    const capsule = width - 12 * k
    const compact = pane < 320 || capsule < row
    const narrowArrows = pane < 180 || capsule < 144 * k
    return {
        width,
        back,
        tiny,
        snug,
        wide,
        inset: (pane - width) / 2 >= w.labels ? 'pt-2' : 'pt-7',
        restoreFits,
        compact,
        narrowArrows,
    }
}

/** The date the strip shows: today's clock, this year's date and time, or the compact form. */
export const peekText = (locale: string, at: number, wide: boolean, now = Date.now()) => {
    const day = new Date(at)
    const today = new Date(now)
    if (day.toDateString() === today.toDateString()) return formatClockSeconds(locale, at)
    if (wide && day.getFullYear() === today.getFullYear())
        return formatDateTimeSeconds(locale, at, now)
    return compactDateTime(locale).format(at)
}
