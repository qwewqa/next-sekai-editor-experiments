import { i18n } from '../../i18n'
import type { SaveSizeEstimate } from '../../local/save/estimate'
import { storageStatus } from '../../local/startup/events'
import { readBrowserFacts, storageLineKey } from '../settings/storageLine'
import type { SaveDialogInput } from './dialogs'
import { totalOf } from './total'

// What the Save dialogs know before a build (Part 1 §1.4.7): the storage line's first sentence,
// the size preview this tab already holds, and the size that decides whether "Preparing…" opens
// at once.

/** The first sentence of a line, in any locale's full stop. */
export const firstSentence = (text: string) => /^.*?[.。](?=\s|$)/su.exec(text)?.[0] ?? text

/**
 * Safari, iPhone and iPad, the first Save in this browser: the storage line's first sentence
 * (§1.4.7, §1.4.13), by the same test the Settings line uses. Undefined elsewhere.
 */
export const storageNote = async (): Promise<(() => string) | undefined> => {
    const facts = await readBrowserFacts().catch(() => undefined)
    if (!facts) return
    const status = storageStatus.value
    const key = storageLineKey({
        ...facts,
        unavailable: status?.mode === 'memory' || status?.mode === 'readOnly',
    })
    if (key !== 'safari' && key !== 'ios') return
    return () => firstSentence(i18n.value.storage[key])
}

// The estimate this tab last loaded for a chain, kept here because the storage worker's own cache
// is out of the page's reach. It is current while the session has taken no entry since and the
// head's BGM is the one it was made for, so a reopen shows it at once.

type Known = { key: string; estimate: SaveSizeEstimate }

const known = new Map<string, Known>()

/** What an estimate was made for: the saved session, its next `seq` and the head's BGM. */
export const estimateKey = (
    session: { id: string; nextSeq: number },
    bgm: string | undefined,
): string => `${session.id}/${session.nextSeq}/${bgm ?? ''}`

export const knownEstimate = (chainId: string, key: string) => {
    const each = known.get(chainId)
    return each?.key === key ? each.estimate : undefined
}

export const rememberEstimate = (chainId: string, key: string, estimate: SaveSizeEstimate) => {
    known.set(chainId, { key, estimate })
}

/** The dialogs' loaded estimates, so the flow sizes a build by what the user saw. */
const loaded = new WeakMap<SaveDialogInput, SaveSizeEstimate>()

export const noteLoaded = (input: SaveDialogInput, estimate: SaveSizeEstimate) => {
    loaded.set(input, estimate)
}

/**
 * The dialog's total for the ticks answered, or undefined while no estimate has loaded or a ticked
 * row's size is unknown.
 */
export const estimatedTotal = (
    input: SaveDialogInput,
    ticks: { history: boolean; bgm: boolean },
) => {
    const estimate = loaded.get(input)
    if (!estimate) return
    return totalOf(estimate, ticks)
}

/** Over this estimated size a download build on a touch device opens "Preparing…" at once (§1.4.7). */
export const LARGE_BUILD_BYTES = 2 * 1024 * 1024

/** A touch device: the activation of a tap may lapse during a long build (§1.5.6). */
export const isTouchDevice = () => {
    try {
        return matchMedia('(any-pointer: coarse)').matches
    } catch {
        return false
    }
}
