import { entryKey } from '../../history/peek'
import { i18n } from '../../i18n'
import { displayName } from '../../local/names'
import type { RecentChain } from '../../local/recent'
import type { ShownName } from '../../local/startup/events'
import { isSafeMode } from '../../safe'
import { restoreStored } from '../restoreStored'
import { backToNow, requestSessionPeek } from './selection'
import { restoreMode, type ChainRow, type SessionRow } from './sessions'
import { historyTab } from './state'

// What Recent Sessions' rows do (Part 1 §1.4.10.6, §1.4.7): Restore Session, Restore as a Copy
// and Save to File…, from the menu, Enter, the peek bar or a load notice. Each runs the checks
// `openSession` makes (lock, head, binding, journal first); the row's badge only picks the label,
// and a stale one never decides anything.

/** A menu item of ManagerMenu, with the reason it is off as its `description` line. */
export type SessionMenuItem = {
    key: string
    label: string
    disabled?: boolean
    destructive?: boolean
    description?: string
    /** The heading over the items: the row's name. */
    group?: string
}

/** The name the row shows: the chain's, or its date when it has none. */
export const shownNameOf = (chain: RecentChain): ShownName => ({
    name: displayName(chain.nameParts),
    at: chain.head.startedAt,
})

/** Restore Session, or Restore as a Copy; true when it opened, and History then shows its Timeline. */
export const restoreRow = async (row: ChainRow, mode: 'restore' | 'copy') => {
    const { opened } = await restoreStored(row.chain.head.sessionId, mode, shownNameOf(row.chain))
    if (opened) {
        // The session peeked (the menu peeks its row) was of the session left.
        backToNow()
        historyTab.value = 'timeline'
    }
    return opened
}

/** Save to File…: the session's head with its history, as a new file. */
export const saveRowToFile = async (row: ChainRow) => {
    const { saveToFile } = await import('../save/flow')
    await saveToFile(row.chain.head.sessionId)
}

/**
 * The row's menu, built in one place. Empty where nothing applies: this tab's row has none, and
 * `?safe` is read-only, so it has no Delete. A damaged row can only be deleted; a row that needs a
 * newer version can be deleted too, though not restored or saved.
 */
export const sessionMenuItems = (
    row: SessionRow,
    held: ReadonlySet<string>,
    safe = isSafeMode(),
): SessionMenuItem[] => {
    if (row.thisTab) return []
    const strings = i18n.value
    // The head may be held since the list was read: the item reads as of now.
    const elsewhere = row.badge === 'elsewhere' || held.has(row.chain.head.sessionId)
    const mode = safe || elsewhere ? 'copy' : 'restore'
    // A row that needs a newer version says why once, under Restore; Save to File… is off the same way.
    const off = row.readable === 'newer' ? { disabled: true } : {}
    const why = row.readable === 'newer' ? { description: strings.load.sessionLater } : {}
    const items: SessionMenuItem[] =
        row.readable === 'damaged'
            ? []
            : [
                  {
                      key: mode,
                      label: mode === 'copy' ? strings.load.restoreAsCopy : strings.open.restoreIt,
                      ...off,
                      ...why,
                  },
                  { key: 'saveToFile', label: strings.history.sessions.saveToFile, ...off },
              ]
    if (!safe)
        items.push({
            key: 'delete',
            label: strings.history.sessions.delete,
            destructive: true,
            // Delete is refused while another tab or window has the chain open.
            ...(elsewhere
                ? { disabled: true, description: strings.history.sessions.openReason }
                : {}),
        })
    return items
}

/** Peeks the row's head, and gives the peek bar its button. */
export const peekSession = (
    row: ChainRow,
    safe: boolean,
    name: string,
    onFailed: (reason: 'damaged' | 'newer') => void,
) => {
    const mode = restoreMode(row, safe)
    if (!mode) return
    requestSessionPeek(
        {
            key: entryKey(row.chain.head.sessionId, row.chain.head.lastSeq),
            chainId: row.chain.chainId,
            name,
            time: row.chain.updatedAt,
            action: mode,
            restore: () => {
                void restoreRow(row, mode)
            },
        },
        onFailed,
    )
}

/** Runs a menu item of `sessionMenuItems`. */
export const runSessionItem = (key: string, row: ChainRow) => {
    if (key === 'restore' || key === 'copy') void restoreRow(row, key)
    else if (key === 'saveToFile') void saveRowToFile(row)
}
