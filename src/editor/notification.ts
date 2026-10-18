import { ref, shallowRef, watch } from 'vue'
import { RELEASE_NOTES_URL } from '../buildInfo'
import { i18n } from '../i18n'
import { launch } from '../launch'
import { isBlockingModalOpen } from '../modals'
import { appVersion, platform } from '../platform'
import { PRODUCT_NAME } from '../product'
import { startupGate } from '../startup/gate'
import { interpolate } from '../utils/interpolate'
import { noticeDuration, RESUME_MIN_MS } from './noticeTiming'

/** A card's one button (Part 1 §1.4.1). */
export type NoticeAction = { label: () => string; run: () => void }

/** One line of the start-up card, with at most one action (Part 1 §1.4.3). */
export type NoticeLine = {
    message: () => string
    action?: NoticeAction
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
}

let id = 0

/** How many load notices the start-up card shows before "and N more in Local Data" (Part 1 §1.4.3). */
export const PILL_NOTICES = 3

// "Next SEKAI Editor / Version X", or "Updated to version X.Y.Z" with What’s New (Part 1 §1.4.3).
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

/** A card has an action or is flagged one; other notices are quick feedback (Part 1 §1.4.1). */
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

/** A load notice (Part 1 §1.4.3): `order` is its place in the table, most important first. */
export type LoadNotice = { order: number; message: () => string; action?: NoticeAction }

/** This page load's load notices in the table's order, for Settings › Local Data › Recovery's "At this load:". */
export const loadNotices = shallowRef<readonly LoadNotice[]>([])

// What "and N more in Local Data" does: set by `loadNotices.ts`, which can import Settings.
let openLocalData: (() => void) | undefined
export const setLocalDataOpener = (open: () => void) => {
    openLocalData = open
}

const pillLines = (): NoticeLine[] => {
    const notices = loadNotices.value
    const shown = notices.slice(0, PILL_NOTICES)
    const lines: NoticeLine[] = [...titleLines(), ...shown]
    if (notices.length > shown.length)
        lines.push({
            message: interpolate(() => i18n.value.load.more, `${notices.length - shown.length}`),
            action: {
                label: () => i18n.value.load.localData,
                run: () => {
                    openLocalData?.()
                },
            },
        })
    return lines
}

// Shows the start-up notice again: with the gate lifted, or with a load notice found. With load
// notices or the update line it is the start-up card; else quick feedback, as in v0.5.22.
const refreshPill = () => {
    if (!notification.value.startup && !noticeCard.value?.startup) return
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
        if (phase === 'done') refreshPill()
    },
)

/**
 * Adds a load notice (Part 1 §1.4.3): a line on the start-up card while it still shows, which then
 * stays about 8 s. Once the card has gone (an edit, another card), the line is only kept, since
 * nothing appears at an arbitrary time.
 */
export const addLoadNotice = (message: () => string, action?: NoticeAction, order = 0) => {
    const notice: LoadNotice = { order, message, action }
    // Stable among equal orders: earlier finds first.
    const at = loadNotices.value.findIndex((other) => other.order > order)
    loadNotices.value =
        at === -1
            ? [...loadNotices.value, notice]
            : [...loadNotices.value.slice(0, at), notice, ...loadNotices.value.slice(at)]
    refreshPill()
}

/**
 * Shows a notice. With an action, or flagged `card`, it is a card: a message with a button and a
 * close button that stays about 6 s, pausing while hovered or focused; Alt+N focuses the button.
 * Anything else is quick feedback, which fades and never replaces a card. Returns the notice's id.
 */
export const notify = (
    message: () => string,
    options?: { action?: NoticeAction; card?: boolean; announcement?: () => string },
) => {
    const notice: Notice = {
        id: id++,
        message,
        action: options?.action,
        card: options?.card,
        announcement: options?.announcement,
    }
    latestNotice.value = notice
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
 * The card at the user's next edit, unless that edit raised it (Part 1 §1.4.1): its Undo or
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
