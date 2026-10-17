import { choiceKey } from './choice'
import type { AssetChoice, AssetStatus, AssetType } from './types'

/** The reason sentence a fallback gets (Part 2, 2.6's `reason.*`): the panel and the dialog share it. */
export type ReasonKey =
    | 'fileGone'
    | 'storageUnavailable'
    | 'serverFailed'
    | 'offline'
    | 'invalid'
    | 'defaultFailed'
    | 'builtinFailed'

/** Why the chosen source was not used, or undefined when it was. */
export const reasonKey = (choice: AssetChoice, status: AssetStatus): ReasonKey | undefined => {
    if (!status.reason) return
    switch (choice.source) {
        case 'default':
            return 'defaultFailed'
        case 'builtin':
            return 'builtinFailed'
        case 'file':
            // Storage that cannot be opened may still hold the file: it is not gone.
            return status.reason === 'corrupt'
                ? 'invalid'
                : status.reason === 'unavailable'
                  ? 'storageUnavailable'
                  : 'fileGone'
        case 'server':
            return status.reason === 'corrupt'
                ? 'invalid'
                : status.reason === 'offline'
                  ? 'offline'
                  : 'serverFailed'
    }
}

/** What a dismissed fallback notice is remembered by: the type, the choice and the reason. */
export const noticeKey = (type: AssetType, choice: AssetChoice, reason: ReasonKey) =>
    `${type}|${choiceKey(choice)}|${reason}`
