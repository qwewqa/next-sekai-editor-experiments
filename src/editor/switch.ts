import { watch } from 'vue'
import { isDirty } from '../history'
import { session } from '../history/session'
import { liveState } from '../history/stack'
import { i18n } from '../i18n'
import { formatDateTime } from '../i18n/when'
import { chainStartOf } from '../local/chainFields'
import { displayName, namePartsOf } from '../local/names'
import { previousSession, type ShownName } from '../local/startup/events'
import { showChoice } from '../modals/choice'
import { setLeaveSafeModeGuard } from '../safe'
import { interpolate } from '../utils/interpolate'
import { takeBgmLine } from './commands/bgm/chooseAudio'
import { runCommand } from './commands/runCommand'
import { save } from './commands/save'
import { hasEditsNotInFile, loadStoring } from './file/closePrompt'
import {
    dismissNoticeCard,
    noticeCard,
    notify,
    type NoticeAction,
    type NoticeLine,
} from './notification'
import { notifyNotOpened } from './openFailure'
import { shownName } from './shownName'
import { withSwitchRequest, type SwitchRequest } from './switchRequest'

// Leaving a session in this tab (New, Open, Reopen, Restore as a Copy, Leave Safe Mode): the
// in-app not-stored prompt, New's unsaved-changes prompt, and the Reopen notice
// that follows. The storage modules load after first paint, so they are imported when a
// switch runs.

/**
 * How long a switch waits for the first write of a visit before it asks. A longer wait could
 * outlast the click that Open's file picker needs.
 */
export const FIRST_WRITE_WAIT_MS = 1000

/**
 * Whether leaving the open session loses work: it has changes no file holds, and it
 * isn't durably stored. The journal is written first, as every switch does.
 */
const wouldLoseWork = async () => {
    const { flusher, isDurablyStored, flushFirstWrite } = await loadStoring()
    const session = flusher?.session
    // Before storing starts, or in safe mode, nothing is stored: `isDirty` decides.
    const edited = session ? session.edited && isDirty.value : isDirty.value
    if (!edited) return false
    // The first write of a visit is due about a second after the first edit, and the switch
    // flushes strictly anyway: only a write that does not happen in time asks.
    if (session) {
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
            flushFirstWrite(),
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, FIRST_WRITE_WAIT_MS)
            }),
        ])
        clearTimeout(timer)
    }
    // A file that holds the work (a Save, an open) is as good as a store.
    return !(session && isDurablyStored()) && hasEditsNotInFile()
}

/**
 * The open session as Reopen will name it: the displayed name, and for a date-named one the
 * chain's first start, not this visit's.
 */
const openName = async (): Promise<ShownName> => {
    const open = session.value
    const parts = namePartsOf(
        {
            name: open.name,
            sourceName: open.sourceName,
            ...(open.file ? { file: { name: open.file.name } } : {}),
        },
        liveState.value,
    )
    const stored = (await loadStoring()).flusher?.session
    const at = chainStartOf(stored?.chain, stored?.startedAt ?? open.startedAt)
    return { name: displayName(parts), ...(at === undefined ? {} : { at }) }
}

/**
 * New asks before it replaces a chart with edits no file holds: "Start a New Chart?" naming the
 * session, [New Chart] [Cancel], Cancel being the default, so a stray `n` replaces nothing.
 */
const confirmUnsaved = async () => {
    if (!hasEditsNotInFile()) return true
    const name = await openName()
    const { at } = name
    return !!(await showChoice({
        title: () => i18n.value.prompt.newTitle,
        message:
            name.name.kind === 'date' && at !== undefined
                ? interpolate(
                      () => i18n.value.prompt.newMessageUntitled,
                      () => formatDateTime(at),
                  )
                : interpolate(
                      () => i18n.value.prompt.newMessage,
                      () => shownName(name),
                  ),
        choices: [{ value: true, label: () => i18n.value.prompt.newChart, danger: true }],
        cancelIsDefault: true,
    }))
}

/**
 * Asks before a switch that would lose work: "Your changes are not being stored in this browser.
 * Leaving will discard them." [Cancel] [Leave Anyway] [Save]. True to go on; Cancel and Save stay.
 * `unsaved` (New): otherwise asks too when the chart has edits no file holds, never twice.
 */
export const confirmSwitch = async ({ unsaved = false } = {}) => {
    if (!(await wouldLoseWork())) return !unsaved || (await confirmUnsaved())
    const choice = await showChoice<'leave' | 'save'>({
        title: () => i18n.value.prompt.title,
        message: () => i18n.value.prompt.notStored,
        choices: [
            { value: 'leave', label: () => i18n.value.prompt.leaveAnyway, danger: true },
            { value: 'save', label: () => i18n.value.prompt.save, default: true },
        ],
    })
    // This session's Save; the switch is left for the user to repeat. Not awaited: the caller may
    // be inside a Save's own queued run (the conflict dialog), which this Save queues behind.
    if (choice === 'save') void runCommand(save, 'button')
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
            void reopenPrevious(left)
        },
    }
}

/**
 * Reopen: continues the session this tab left last, after the prompt when the open one would
 * lose work. True when it opened. A card passes the session it offered: when this tab has left
 * another since, nothing opens.
 */
export const reopenPrevious = (offered?: Left) =>
    // Checked before a request exists: a request supersedes the switch that is finishing.
    offered && previousSession.value !== offered
        ? Promise.resolve(false)
        : withSwitchRequest(undefined, async (request) => {
              const left = previousSession.value
              if (!left) return false
              if (!(await confirmSwitch()) || !request.isCurrent()) return false
              const { reopenSession } = await import('../local/startup/api')
              if (!request.isCurrent()) return false
              reopening = request
              try {
                  const result = await reopenSession(request)
                  if (result.opened && request.isCurrent()) await afterSwitch()
                  else if (!result.opened && request.isCurrent()) {
                      // A session that is gone is offered no more: its card goes, and does not turn plain.
                      if (
                          (result.why === 'deleted' || result.why === 'missing') &&
                          previousSession.value === left
                      ) {
                          dismissNoticeCard()
                          previousSession.value = undefined
                      }
                      notifyNotOpened(result)
                  }
                  return result.opened
              } finally {
                  if (reopening === request) reopening = undefined
              }
          })

/** The card a Reopen or a Restore as a Copy from a load notice leaves: gone, or the BGM line alone. */
const afterSwitch = async () => {
    dismissNoticeCard()
    const line = await takeBgmLine()
    if (line)
        notify(line.message, {
            card: true,
            ...(line.severity ? { severity: line.severity } : {}),
            ...(line.action ? { action: line.action } : {}),
        })
}

/** Restore as a Copy from a load notice. */
export const restoreCopy = (sessionId: string) =>
    withSwitchRequest(undefined, async (request) => {
        if (!(await confirmSwitch()) || !request.isCurrent()) return false
        const { restoreAsCopy } = await import('../local/startup/api')
        if (!request.isCurrent()) return false
        const result = await restoreAsCopy(sessionId, request)
        if (!request.isCurrent()) return result.opened
        if (result.opened) await afterSwitch()
        else notifyNotOpened(result)
        return result.opened
    })

/**
 * The notice after a switch: its message, and Reopen "<previous>" while the session left can be
 * reopened, unless `offer` is false. When it turns out not to be (Leave Anyway), the
 * notice is plain. `line` is a second row of the card (the BGM that is not loaded).
 */
export const notifyLeft = (message: () => string, offer = true, line?: NoticeLine) => {
    // The switch ends the session the cards were raised in.
    dismissNoticeCard()
    const left = previousSession.value
    // A screen reader hears the second row too.
    const rows = (first: NoticeLine, second: NoticeLine) => ({
        lines: [first, second],
        announcement: () => `${message()} ${second.message()}`,
    })
    const plain = () => {
        if (line) notify(message, rows({ message }, line))
        else notify(message)
    }
    if (!left || !offer) {
        plain()
        return
    }
    const shown = line
        ? notify(message, rows({ message, action: reopenAction(left) }, line))
        : notify(message, { action: reopenAction(left) })
    // Stops once the card is gone however it went (dismissed, replaced, used), so a switch leaves
    // no watcher behind.
    const stop = watch(
        [() => previousSession.value, () => noticeCard.value?.id === shown],
        ([now, showing]) => {
            // Another switch replaces the session while its own notice is on the way: not a
            // sign that there is nothing to reopen.
            if (showing && now !== undefined) return
            stop()
            if (!showing) return
            // Nothing to reopen after all (Leave Anyway): a card still showing turns plain.
            if (reopening || noticeCard.value?.id !== shown) return
            dismissNoticeCard()
            plain()
        },
    )
}
