import { watch } from 'vue'
import { isDirty } from '../history'
import { i18n } from '../i18n'
import { formatDateTime } from '../i18n/when'
import { previousSession } from '../local/startup/events'
import { showChoice } from '../modals/choice'
import { setLeaveSafeModeGuard } from '../safe'
import { interpolate } from '../utils/interpolate'
import { runCommand } from './commands/runCommand'
import { save } from './commands/save'
import { dismissNoticeCard, noticeCard, notify, type NoticeAction } from './notification'
import { shownName } from './shownName'
import { withSwitchRequest, type SwitchRequest } from './switchRequest'

// Leaving a session in this tab (New, Open, Reopen, Restore as a Copy, Leave Safe Mode): the
// in-app not-stored prompt (Part 1 §1.4.9), and the Reopen notice that follows (§1.4.1). The
// storage modules load after first paint, so they are imported when a switch runs.

/**
 * Whether leaving the open session loses work (§1.4.9): it has changes no file holds, and it
 * isn't durably stored. The journal is written first, as every switch does.
 */
const wouldLoseWork = async () => {
    const { flusher, isDurablyStored } = await import('../local/storing')
    const session = flusher?.session
    // Before storing starts, or in safe mode, nothing is stored: today's changes flag decides.
    const edited = session ? session.edited && isDirty.value : isDirty.value
    if (!edited) return false
    return !(session && isDurablyStored())
}

/**
 * Asks before a switch that would lose work: "Your changes are not being stored in this browser.
 * Leaving loses them." [Cancel] [Leave Anyway] [Save]. True to go on; Cancel and Save stay.
 */
export const confirmSwitch = async () => {
    if (!(await wouldLoseWork())) return true
    const choice = await showChoice<'leave' | 'save'>({
        title: () => i18n.value.prompt.title,
        message: () => i18n.value.prompt.notStored,
        choices: [
            { value: 'leave', label: () => i18n.value.prompt.leaveAnyway, danger: true },
            { value: 'save', label: () => i18n.value.prompt.save, default: true },
        ],
    })
    // This session's Save (§1.4.7); the switch is left for the user to repeat, and Step 8 adds
    // the "Saved to … · Continue" follow-up.
    if (choice === 'save') await runCommand(save)
    return choice === 'leave'
}

// Leave Safe Mode runs it too, since iOS has no leave prompt and safe mode stores nothing.
setLeaveSafeModeGuard(confirmSwitch)

type Left = NonNullable<typeof previousSession.value>

// Reopen clears the session it opens, which is no sign that there was nothing to reopen.
let reopening: SwitchRequest | undefined

// A session without a name of its own is named by its date, which takes no quotes.
// Without its start, the date fallback is just "Untitled".
const reopenAction = (left: Left): NoticeAction => {
    const { at } = left.name
    return {
        label:
            left.name.name.kind === 'date' && at !== undefined
                ? interpolate(
                      () => i18n.value.notice.reopenUntitled,
                      () => formatDateTime(at),
                  )
                : interpolate(
                      () => i18n.value.notice.reopen,
                      () => shownName(left.name),
                  ),
        run: () => {
            void reopenPrevious()
        },
    }
}

/**
 * Reopen: continues the session this tab left last, after the prompt when the open one would
 * lose work. True when it opened.
 */
export const reopenPrevious = () =>
    withSwitchRequest(undefined, async (request) => {
        if (!previousSession.value || !(await confirmSwitch()) || !request.isCurrent()) return false
        const { reopen } = await import('../local/startup/api')
        if (!request.isCurrent()) return false
        reopening = request
        try {
            const opened = await reopen(request)
            if (opened && request.isCurrent()) dismissNoticeCard()
            return opened
        } finally {
            if (reopening === request) reopening = undefined
        }
    })

/** Restore as a Copy from a load notice. */
export const restoreCopy = (sessionId: string) =>
    withSwitchRequest(undefined, async (request) => {
        if (!(await confirmSwitch()) || !request.isCurrent()) return false
        const { restoreAsCopy } = await import('../local/startup/api')
        if (!request.isCurrent()) return false
        const opened = await restoreAsCopy(sessionId, request)
        if (opened && request.isCurrent()) dismissNoticeCard()
        return opened
    })

/**
 * The notice after a switch: its message, and Reopen "<previous>" while the session left can be
 * reopened (§1.4.1), unless `offer` is false. When it turns out not to be (Leave Anyway), the
 * notice is plain.
 */
export const notifyLeft = (message: () => string, offer = true) => {
    // The switch ends the session the cards were raised in (Part 1 §1.4.1).
    dismissNoticeCard()
    const left = previousSession.value
    if (!left || !offer) {
        notify(message)
        return
    }
    const shown = notify(message, { action: reopenAction(left) })
    const stop = watch(
        () => previousSession.value === left,
        (still) => {
            if (still) return
            stop()
            // Nothing to reopen after all (Leave Anyway): a card still showing turns plain.
            if (reopening || noticeCard.value?.id !== shown) return
            dismissNoticeCard()
            notify(message)
        },
    )
}
