import { session } from '../history/session'
import { i18n } from '../i18n'
import type { ShownName } from '../local/startup/events'
import { interpolateRaw } from '../utils/interpolate'
import { takeBgmLine } from './commands/bgm/chooseAudio'
import { displayedName } from './labelText'
import { notify } from './notification'
import { copySourceName, shownName } from './shownName'
import { confirmSwitch, notifyLeft } from './switch'
import { withSwitchRequest } from './switchRequest'

// Restore Session and Restore as a Copy of a stored session (Part 1 §1.4.10.6, §1.4.3): from
// Recent Sessions' rows and menu, its peek bar, and the load notices' [Restore Session]. Not in
// `history/`, whose files format in the History calendar's zone: the card's name is a notice's.

/** What Restore Session and Restore as a Copy did, for the notice and the list. */
export type RestoreResult =
    | { opened: true; forked: boolean }
    | { opened: false; why: 'none' | 'deleted' | 'missing' | 'later' | 'damaged' | 'blank' }

const failureLine = (why: 'deleted' | 'missing' | 'later' | 'damaged') => {
    const { load } = i18n.value
    return why === 'deleted'
        ? load.sessionDeleted
        : why === 'later'
          ? load.sessionLater
          : load.sessionDamaged
}

/**
 * Restore Session, or Restore as a Copy (`mode`), of a stored session: after the not-stored
 * prompt, then the switch card: "Restored "X"" or "Restored a copy of "X"" with Reopen. `name` is
 * the row's; without it the name of what opened stands. A session that could not be opened says
 * why. Nothing happens when the request was replaced or the prompt was answered with Cancel.
 */
export const restoreStored = (
    sessionId: string,
    mode: 'restore' | 'copy',
    name?: ShownName,
): Promise<RestoreResult> =>
    withSwitchRequest(undefined, async (request): Promise<RestoreResult> => {
        const blank = { opened: false, why: 'blank' } as const
        if (!(await confirmSwitch()) || !request.isCurrent()) return blank
        const api = await import('../local/startup/api')
        if (!request.isCurrent()) return blank
        const result = await (mode === 'copy' ? api.restoreAsCopy : api.restoreSession)(
            sessionId,
            request,
        )
        if (!request.isCurrent()) return result
        if (!result.opened) {
            if (result.why !== 'none' && result.why !== 'blank') {
                const { why } = result
                notify(() => failureLine(why))
            }
            return result
        }
        const open = session.value
        const shown = name
            ? shownName(name)
            : result.forked && open.copyOf
              ? copySourceName(open.copyOf)
              : displayedName.value
        const line = await takeBgmLine()
        if (!request.isCurrent()) return result
        notifyLeft(
            () =>
                interpolateRaw(
                    result.forked ? i18n.value.session.restoredCopy : i18n.value.session.restored,
                    shown,
                ),
            true,
            line,
        )
        return result
    })
