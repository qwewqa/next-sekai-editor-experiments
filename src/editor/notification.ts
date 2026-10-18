import { shallowRef, watch } from 'vue'
import { RELEASE_NOTES_URL } from '../buildInfo'
import { i18n } from '../i18n'
import { launch } from '../launch'
import { appVersion, platform } from '../platform'
import { PRODUCT_NAME } from '../product'
import { startupGate } from '../startup/gate'
import { interpolate } from '../utils/interpolate'

/** A notice's one button (Part 1 §1.4.1). */
export type NoticeAction = { label: () => string; run: () => void }

/** One line of the start-up pill, with at most one action (Part 1 §1.4.3). */
export type NoticeLine = { message: () => string; action?: NoticeAction }

export type Notice = {
    id: number
    message?: () => string
    /** The first line's action, or the first of the pill's lines that has one. */
    action?: NoticeAction
    /** The start-up pill's lines, each with its own action. */
    lines?: NoticeLine[]
    /** What the live region reads in place of the message, such as the message and another way to the action. */
    announcement?: () => string
    /** The start-up pill, which stays a little longer. */
    startup?: boolean
    /** A pill with load notices: it stays and times out as an action notice does, button or not. */
    held?: boolean
}

/** How long a notice with an action stays (Part 1 §1.4.1, §1.4.3). */
export const NOTICE_MS = 6000
export const STARTUP_NOTICE_MS = 8000
/** The least a notice has left once hover or focus lets go, so it can still be read. */
const RESUME_MIN_MS = 1500

let id = 0

/** How many load notices the pill shows before "and N more in Local Data" (Part 1 §1.4.3). */
export const PILL_NOTICES = 3

// "Next SEKAI Editor / Version X", or "Updated to version X.Y.Z" with What’s New (Part 1 §1.4.3).
const titleLines = (): NoticeLine[] => {
    const name = PRODUCT_NAME
    if (launch.updated)
        return [
            { message: () => name },
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
        { message: () => name },
        { message: interpolate(() => i18n.value.load.version, appVersion().appVersion) },
    ]
}

const noticeOf = (lines: NoticeLine[], held: boolean): Notice => ({
    id: id++,
    startup: true,
    held,
    lines,
    message: () => lines.map((line) => line.message()).join('\n'),
    action: lines.find((line) => line.action)?.action,
})

export const notification = shallowRef<Notice>(noticeOf(titleLines(), false))

let timer: ReturnType<typeof setTimeout> | undefined
let remaining = 0
let startedAt = 0
const holds = new Set<string>()

const stopTimer = () => {
    clearTimeout(timer)
    timer = undefined
}

const startTimer = (ms: number) => {
    stopTimer()
    remaining = ms
    startedAt = Date.now()
    const shown = notification.value.id
    timer = setTimeout(() => {
        // A later notice has its own timer.
        if (notification.value.id === shown) dismissNotification()
    }, ms)
    // A timer left by a test never holds the process open.
    ;(timer as { unref?: () => void }).unref?.()
}

const track = () => {
    holds.clear()
    stopTimer()
    // The start-up pill is out of sight, and its time not running, while the startup gate shows.
    if (notification.value.startup && startupGate.phase !== 'done') return
    if (notification.value.action || notification.value.held)
        startTimer(notification.value.startup ? STARTUP_NOTICE_MS : NOTICE_MS)
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

// Shows the pill again: with the gate lifted, or with a load notice found.
const refreshPill = () => {
    if (!notification.value.startup) return
    notification.value = noticeOf(pillLines(), loadNotices.value.length > 0)
    track()
}

watch(
    () => startupGate.phase,
    (phase) => {
        if (phase === 'done') refreshPill()
    },
)

/**
 * Adds a load notice (Part 1 §1.4.3): a line on the start-up pill while it still shows, which then
 * stays about 8 s. Once the pill has gone (an edit, another notice), the line is only kept, since
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
 * Shows a notice. With an action it is a pill with a button that stays about 6 s, pausing while
 * hovered or focused; Alt+N focuses the button. Returns the notice's id.
 */
export const notify = (
    message: () => string,
    options?: { action?: NoticeAction; announcement?: () => string },
) => {
    notification.value = {
        id: id++,
        message,
        action: options?.action,
        announcement: options?.announcement,
    }
    track()
    return notification.value.id
}

/** Removes the shown notice, whatever it is. */
export const dismissNotification = () => {
    notification.value = { id: notification.value.id }
    track()
}

/**
 * Removes a plain notice that no longer holds, such as one for a drag that changed nothing.
 * A notice with an action (Undo, Reopen, the update line) or load notices is another feature's, so it stays.
 */
export const clearNotification = () => {
    if (notification.value.action || notification.value.held) return
    dismissNotification()
}

/** Pauses the notice's timeout while the pointer or focus is on it. */
export const holdNotice = (source: 'hover' | 'focus', held: boolean) => {
    if (!notification.value.action && !notification.value.held) return
    if (held) {
        if (!holds.size && timer !== undefined) {
            stopTimer()
            remaining -= Date.now() - startedAt
        }
        holds.add(source)
    } else if (holds.delete(source) && !holds.size) {
        startTimer(Math.max(remaining, RESUME_MIN_MS))
    }
}

/** What the live region reads for the current notice. */
export const announcementOf = (notice: Notice) => (notice.announcement ?? notice.message)?.() ?? ''
