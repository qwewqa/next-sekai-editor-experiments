import { shallowRef } from 'vue'
import { RELEASE_NOTES_URL } from '../buildInfo'
import { i18n } from '../i18n'
import { launch } from '../launch'
import { appVersion, platform } from '../platform'
import { PRODUCT_NAME } from '../product'
import { interpolate } from '../utils/interpolate'

/** A notice's one button (Part 1 §1.4.1). */
export type NoticeAction = { label: () => string; run: () => void }

export type Notice = {
    id: number
    message?: () => string
    action?: NoticeAction
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

// "Next SEKAI Editor / Version X", or "Updated to version X.Y.Z" with What’s New (Part 1 §1.4.3).
const startupNotice = (): Notice => {
    const name = PRODUCT_NAME
    if (launch.updated)
        return {
            id: id++,
            startup: true,
            message: interpolate(() => `${name}\n${i18n.value.load.updated}`, launch.release),
            action: {
                label: () => i18n.value.load.whatsNew,
                run: () => {
                    platform.openExternal(RELEASE_NOTES_URL)
                },
            },
        }
    return {
        id: id++,
        startup: true,
        message: interpolate(() => `${name}\n${i18n.value.load.version}`, appVersion().appVersion),
    }
}

export const notification = shallowRef<Notice>(startupNotice())

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
        if (notification.value.id === shown) clearNotification()
    }, ms)
    // A timer left by a test never holds the process open.
    ;(timer as { unref?: () => void }).unref?.()
}

const track = () => {
    holds.clear()
    stopTimer()
    if (notification.value.action || notification.value.held)
        startTimer(notification.value.startup ? STARTUP_NOTICE_MS : NOTICE_MS)
}
track()

/** This page load's load notices, for Settings › Local Data › Recovery's "At this load:". */
export const loadNotices: { message: () => string; action?: NoticeAction }[] = []

/**
 * Adds a load notice (Part 1 §1.4.3): a line on the start-up pill while it still shows, which then
 * stays about 8 s. Once the pill has gone (an edit, another notice), the line is only kept, since
 * nothing appears at an arbitrary time. A load notice's action takes the pill's one button.
 */
export const addLoadNotice = (message: () => string, action?: NoticeAction) => {
    loadNotices.push({ message, action })
    const current = notification.value
    if (!current.startup || !current.message) return
    const previous = current.message
    notification.value = {
        id: id++,
        startup: true,
        held: true,
        message: () => `${previous()}
${message()}`,
        action: action ?? current.action,
    }
    track()
}

/**
 * Shows a notice. With an action it is a pill with a button that stays about 6 s, pausing while
 * hovered or focused; Alt+N focuses the button.
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
}

/** Removes a notice that no longer holds, such as one for a drag that changed nothing. */
export const clearNotification = () => {
    notification.value = { id: notification.value.id }
    track()
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
