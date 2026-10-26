import { ref, shallowRef, watch } from 'vue'
import { bump } from '../analytics/tally'
import { RELEASE_NOTES_URL } from '../buildInfo'
import { onHistoryAction } from '../history/actions'
import { i18n } from '../i18n'
import { launch } from '../launch'
import { isBlockingModalOpen } from '../modals'
import { appVersion, platform } from '../platform'
import { PRODUCT_NAME } from '../product'
import { startupGate } from '../startup/gate'
import { interpolate } from '../utils/interpolate'
import { formatCount } from '../utils/size'
import { noticeDuration, RESUME_MIN_MS } from './noticeTiming'

/** A card's one button. */
export type NoticeAction = { label: () => string; run: () => void }

/**
 * What a card's glyph says (colour system §5.6). Error: what was asked for did not happen. Warning:
 * work is at risk or was affected. Info: worth knowing, with nothing at risk. A notice without one
 * is neutral (a confirmation or a route back) and has no glyph.
 */
export type NoticeSeverity = 'info' | 'warning' | 'error'

/** One line of the start-up card, with at most one action. */
export type NoticeLine = {
    message: () => string
    action?: NoticeAction
    severity?: NoticeSeverity
    /** The name and version, which the card joins into its heading. */
    heading?: boolean
}

export type Notice = {
    id: number
    message?: () => string
    /** The first line's action, or the first of the card's lines that has one. */
    action?: NoticeAction
    /** The start-up card's lines, each with its own action. */
    lines?: NoticeLine[]
    /** What the live region reads in place of the message, such as the message and another way to the action. */
    announcement?: () => string
    /** The start-up notice, which stays a little longer. */
    startup?: boolean
    /** A message that must be read: a card without an action. */
    card?: boolean
    severity?: NoticeSeverity
}

let id = 0

/**
 * How many load notices the start-up card shows before "and N more in Local Data".
 * One more would be a row as tall as the line it hides, so that many show whole.
 */
export const PILL_NOTICES = 3

// "Next SEKAI Editor / Version X", or "Updated to version X.Y.Z" with Release Notes.
const titleLines = (): NoticeLine[] => {
    const name = PRODUCT_NAME
    if (launch.updated)
        return [
            { message: () => name, heading: true },
            {
                message: interpolate(() => i18n.value.load.updated, launch.release),
                action: {
                    label: () => i18n.value.load.whatsNew,
                    run: () => {
                        platform.openExternal(RELEASE_NOTES_URL)
                    },
                },
            },
        ]
    return [
        { message: () => name, heading: true },
        {
            message: interpolate(() => i18n.value.load.version, appVersion().appVersion),
            heading: true,
        },
    ]
}

/** A card has an action or is flagged one; other notices are quick feedback. */
const isCard = (notice: Notice) => notice.action !== undefined || notice.card === true

const noticeOf = (lines: NoticeLine[]): Notice => ({
    id: id++,
    startup: true,
    lines,
    message: () => lines.map((line) => line.message()).join('\n'),
    action: lines.find((line) => line.action)?.action,
    // Load notices make a card even when none has a button.
    card: lines.some((line) => !line.heading),
})

const first = noticeOf(titleLines())

/** Quick feedback: one at a time, fading by itself, never replacing a card. */
export const notification = shallowRef<Notice>(isCard(first) ? { id: first.id } : first)
/** The card: one at a time, with a close button, and a timeout. */
export const noticeCard = shallowRef<Notice | undefined>(isCard(first) ? first : undefined)
/** The notice raised last, whichever slot it is in, for the live region. */
export const latestNotice = shallowRef<Notice>(first)

// Where a notice raised while a blocking dialog was open is drawn: over that dialog.
export const cardInDialog = ref(false)
export const quickInDialog = ref(false)
let quickAt = 0
/** A quick notice fades in 1 s, to the faint text v0.5.22 leaves behind until the next notice. */
const QUICK_FADE_MS = 1000

let timer: ReturnType<typeof setTimeout> | undefined
let remaining = 0
let startedAt = 0
type HoldSource = 'hover' | 'focus' | 'hidden' | 'dialog'
const holds = new Set<HoldSource>()
// The card raised in this task, which the edit that raised it must not dismiss.
let raisedNow = -1

const stopTimer = () => {
    clearTimeout(timer)
    timer = undefined
}

// The start-up card is out of sight, and its time not running, while the startup gate shows.
const waitingOnGate = (card: Notice) => !!card.startup && startupGate.phase !== 'done'

const startTimer = (ms: number) => {
    stopTimer()
    remaining = ms
    startedAt = Date.now()
    const shown = noticeCard.value?.id
    timer = setTimeout(() => {
        // A later card has its own timer.
        if (noticeCard.value?.id === shown) dismissNoticeCard()
    }, ms)
    // A timer left by a test never holds the process open.
    ;(timer as { unref?: () => void }).unref?.()
}

/** A blocking dialog covers a card drawn in the pane. */
const covered = () => isBlockingModalOpen.value && !cardInDialog.value
const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

const track = () => {
    holds.clear()
    stopTimer()
    const card = noticeCard.value
    if (!card) return
    remaining = noticeDuration(!!card.startup, (card.message?.() ?? '').length)
    if (hidden()) holds.add('hidden')
    if (covered()) holds.add('dialog')
    if (holds.size || waitingOnGate(card)) return
    startTimer(remaining)
}
track()

/** A load notice: `order` is its place in the table, most important first. */
export type LoadNotice = {
    order: number
    message: () => string
    action?: NoticeAction
    severity?: NoticeSeverity
}

/** This page load's load notices in the table's order, for Settings › Local Data › Recovery's "At this load". */
export const loadNotices = shallowRef<readonly LoadNotice[]>([])

// What "and N more in Local Data" does: set by `loadNotices.ts`, which can import Settings.
let openLocalData: (() => void) | undefined
export const setLocalDataOpener = (open: () => void) => {
    openLocalData = open
}

const pillLines = (): NoticeLine[] => {
    const notices = loadNotices.value
    const shown = notices.length > PILL_NOTICES + 1 ? notices.slice(0, PILL_NOTICES) : notices
    const lines: NoticeLine[] = [...titleLines(), ...shown]
    if (notices.length > shown.length)
        lines.push({
            message: interpolate(
                () => i18n.value.load.more,
                formatCount(notices.length - shown.length),
            ),
            action: {
                label: () => i18n.value.load.localData,
                // The opener itself, so the shown Local Data lines count as this line's twins.
                run:
                    openLocalData ??
                    (() => {
                        openLocalData?.()
                    }),
            },
        })
    // One button per action: a line whose action a later line repeats leaves it to that line.
    const same = (a: NoticeAction, b: NoticeAction) => a.run === b.run && a.label() === b.label()
    return lines.map((line, i) => {
        const { action } = line
        if (
            !action ||
            !lines.slice(i + 1).some((later) => later.action && same(later.action, action))
        )
            return line
        return { message: line.message, heading: line.heading, severity: line.severity }
    })
}

/** How long after the page loaded its start-up toast may still become the start-up card. */
const STARTUP_WINDOW_MS = 12_000

// An edit, undo, redo or restore since load: a card after it would interrupt the work.
let workedSinceLoad = false
onHistoryAction(({ kind }) => {
    if (kind === 'edit' || kind === 'restore' || kind === 'undo' || kind === 'redo')
        workedSinceLoad = true
})

/**
 * Whether the start-up notice is still the one shown, so a load notice may join it: its card, or
 * the quick toast of a clean load while the page is under 12 s old and nothing was edited, undone,
 * redone or restored. Never the faint text left after it.
 */
export const startupNoticeCurrent = () =>
    noticeCard.value?.startup === true ||
    (notification.value.startup === true &&
        !workedSinceLoad &&
        performance.now() < STARTUP_WINDOW_MS)

// The start-up notice, not yet replaced by another: what the gate's lifting shows again.
const startupKept = () => notification.value.startup === true || noticeCard.value?.startup === true

// Shows the start-up notice again: with the gate lifted, or with a load notice found. With load
// notices or the update line it is the start-up card; else quick feedback, as in v0.5.22.
const refreshPill = () => {
    const next = noticeOf(pillLines())
    latestNotice.value = next
    if (isCard(next)) {
        if (notification.value.startup) notification.value = { id: notification.value.id }
        noticeCard.value = next
        cardInDialog.value = false
        track()
    } else {
        quickAt = Date.now()
        notification.value = next
    }
}

watch(
    () => startupGate.phase,
    (phase) => {
        if (phase === 'done' && startupKept()) refreshPill()
    },
)

/**
 * Adds a load notice. Before the gate lifts, it waits for it with the rest. After,
 * it is a line on the start-up notice while that is current, and the card then stays about 8 s.
 * Otherwise (an edit, another notice, 12 s) the line is only kept, since nothing appears at an
 * arbitrary time.
 */
export const addLoadNotice = (
    message: () => string,
    action?: NoticeAction,
    order = 0,
    severity?: NoticeSeverity,
) => {
    const notice: LoadNotice = { order, message, action, severity }
    // Stable among equal orders: earlier finds first.
    const at = loadNotices.value.findIndex((other) => other.order > order)
    loadNotices.value =
        at === -1
            ? [...loadNotices.value, notice]
            : [...loadNotices.value.slice(0, at), notice, ...loadNotices.value.slice(at)]
    if (startupGate.phase === 'done' ? startupNoticeCurrent() : startupKept()) refreshPill()
}

/**
 * Shows a notice. With an action, or flagged `card`, it is a card: a message with a button and a
 * close button that stays about 6 s, pausing while hovered or focused; Alt+N focuses the button.
 * Anything else is quick feedback, which fades and never replaces a card. Returns the notice's id.
 */
export const notify = (
    message: () => string,
    options?: {
        action?: NoticeAction
        card?: boolean
        announcement?: () => string
        /** The card's glyph. A quick toast has no glyph, so a severity without `card` or `action` is dropped. */
        severity?: NoticeSeverity
        /**
         * A card of several rows, as the start-up card's: a heading line, then a row for each other
         * line, with its own glyph and action. `message` is then the lines joined.
         */
        lines?: NoticeLine[]
    },
) => {
    const notice: Notice = {
        id: id++,
        message,
        action: options?.action ?? options?.lines?.find((line) => line.action)?.action,
        card: options?.card ?? (options?.lines ? true : undefined),
        announcement: options?.announcement,
        severity: options?.severity,
        ...(options?.lines ? { lines: options.lines } : {}),
    }
    latestNotice.value = notice
    if (options?.severity) bump(`notices.${options.severity}`)
    if (isCard(notice)) {
        raisedNow = notice.id
        queueMicrotask(() => {
            if (raisedNow === notice.id) raisedNow = -1
        })
        cardInDialog.value = isBlockingModalOpen.value
        noticeCard.value = notice
        // A card replaces the start-up toast and the faint text a finished toast leaves, as any
        // notice did in v0.5.22.
        if (notification.value.startup || Date.now() - quickAt > QUICK_FADE_MS)
            dismissNotification()
        track()
    } else {
        quickInDialog.value = isBlockingModalOpen.value
        quickAt = Date.now()
        notification.value = notice
    }
    return notice.id
}

/** Removes the quick notice, whatever it is. */
export const dismissNotification = () => {
    notification.value = { id: notification.value.id }
    quickInDialog.value = false
}

/** Removes the card: the close button, a swipe, Esc in it, its timeout, a later edit or a switch. */
export const dismissNoticeCard = () => {
    if (!noticeCard.value) return
    noticeCard.value = undefined
    cardInDialog.value = false
    track()
}

/**
 * Takes what offers `action` off the card, because what it offered is done (a BGM attached): the
 * card itself when nothing else is on it, else its other rows.
 */
export const dropCardAction = (action: NoticeAction) => {
    const card = noticeCard.value
    if (!card) return
    const { lines } = card
    if (!lines) {
        if (card.action === action) dismissNoticeCard()
        return
    }
    if (!lines.some((line) => line.action === action)) return
    const rest = lines.filter((line) => line.action !== action)
    const [only] = rest
    if (!only || rest.every((line) => line.heading)) {
        dismissNoticeCard()
        return
    }
    // A new id hands back the focus the removed button held.
    noticeCard.value = {
        ...card,
        id: id++,
        lines: rest,
        message: card.startup ? () => rest.map((line) => line.message()).join('\n') : only.message,
        action: rest.find((line) => line.action)?.action,
        announcement: undefined,
    }
    track()
}

/**
 * The card at the user's next edit, unless that edit raised it: its Undo or
 * Reopen never outlives the state it was offered for.
 */
export const dismissCardForEdit = () => {
    if (noticeCard.value && noticeCard.value.id !== raisedNow) dismissNoticeCard()
}

/**
 * Removes quick feedback that no longer holds, such as one for a drag that changed nothing. A
 * card (Undo, Reopen, the update line, load notices) is another feature's, so it stays.
 */
export const clearNotification = () => {
    dismissNotification()
}

/** Pauses the card's timeout while the pointer or focus is on it, the page is hidden or a dialog covers it. */
export const holdNotice = (source: HoldSource, held: boolean) => {
    const card = noticeCard.value
    if (!card) return
    if (held) {
        if (!holds.size && timer !== undefined) {
            stopTimer()
            remaining -= Date.now() - startedAt
        }
        holds.add(source)
    } else if (holds.delete(source) && !holds.size && !waitingOnGate(card)) {
        startTimer(Math.max(remaining, RESUME_MIN_MS))
    }
}

if (typeof document !== 'undefined')
    document.addEventListener('visibilitychange', () => {
        holdNotice('hidden', hidden())
    })

watch(
    isBlockingModalOpen,
    (open) => {
        holdNotice('dialog', open && !cardInDialog.value)
        if (open) return
        // What a dialog showed moves to the pane, a quick notice only while it still shows.
        cardInDialog.value = false
        if (quickInDialog.value) {
            quickInDialog.value = false
            if (Date.now() - quickAt > QUICK_FADE_MS) dismissNotification()
        }
    },
    { flush: 'sync' },
)

/** What the live region reads for a notice. */
export const announcementOf = (notice: Notice) => (notice.announcement ?? notice.message)?.() ?? ''
