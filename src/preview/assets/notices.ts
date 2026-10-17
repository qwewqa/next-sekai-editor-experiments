import { DISMISSED_NOTICE_LIMIT } from './choice'
import { noticeKey, reasonKey, type ReasonKey } from './reasons'
import type { AssetSlot } from './session'
import type { AssetType } from './types'

export type FallbackState = {
    type: AssetType
    reason: ReasonKey
    /** What is used instead. */
    using: 'default' | 'builtin' | 'stored'
    /** The stored item still showing, when that is what is used. */
    usingTitle: string
    /** Where the failed choice came from, for a server's address in the sentence. */
    origin: string
    /** What a dismissal is remembered by. */
    key: string
}

/** The fallback a loaded type is in, if its choice was not used. */
export const fallbackOf = (
    type: AssetType,
    slot: AssetSlot<AssetType>,
): FallbackState | undefined => {
    const { status, choice } = slot
    if (!status || !choice) return
    const reason = reasonKey(choice, status)
    if (!reason) return
    return {
        type,
        reason,
        using: status.active === 'chosen' ? 'stored' : status.active,
        usingTitle: status.usingTitle ?? '',
        origin: choice.source === 'file' || choice.source === 'server' ? choice.origin : '',
        key: noticeKey(type, choice, reason),
    }
}

/** The fallbacks the panel's line still shows: those not dismissed for this choice and reason. */
export const undismissed = (list: FallbackState[], dismissed: readonly string[]) =>
    list.filter((fallback) => !dismissed.includes(fallback.key))

/** The dismissed list with one more, the oldest dropped past the limit. */
export const withDismissed = (dismissed: readonly string[], key: string) =>
    dismissed.includes(key) ? [...dismissed] : [...dismissed, key].slice(-DISMISSED_NOTICE_LIMIT)
