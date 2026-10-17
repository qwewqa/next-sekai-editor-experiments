import type { State } from '../../state'
import { CHAIN_OWN_FIELDS } from '../chainFields'
import type { FlushSession, PendingEntry } from '../flush'
import { toHex } from '../hash'
import { RECORDS_V } from '../records/version'
import type { ModelSlot, SlotStack } from '../timeline'
import { journalContent } from './content'
import {
    JOURNAL_VERSION,
    type JournalDescriptor,
    type JournalStack,
    type JournalV1,
} from './format'

// Building a journal from the tab's session (§1.6.4 #7, §1.6.11.3): the descriptor from what
// the page knows and the chain record the last flush wrote, the whole state, and the stack by
// reference to what's committed.

const hexOf = (value: unknown) => (value instanceof Uint8Array ? toHex(value) : value)

/** A binding or Export target without its handle, hashes as hex (§1.6.11.3). */
const withoutHandle = (value: unknown) => {
    if (typeof value !== 'object' || value === null) return value
    const { handle: _handle, ...rest } = value as Record<string, unknown>
    return 'hash' in rest ? { ...rest, hash: hexOf(rest.hash) } : rest
}

/** A chain record's fields as a descriptor carries them: no handles, hashes as hex. */
export const descriptorChainFields = (record: Record<string, unknown>) => {
    const fields: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(record)) {
        if (CHAIN_OWN_FIELDS.includes(key)) continue
        if (key === 'file' || key === 'exportTarget') fields[key] = withoutHandle(value)
        else if (key === 'badChunks') fields[key] = hexOf(value)
        else fields[key] = value
    }
    return fields
}

/** The session descriptor: everything needed to recreate the session row and its chain. */
export const descriptorOf = (session: FlushSession): JournalDescriptor => {
    const stored = session.chain ? descriptorChainFields(session.chain) : {}
    const origin = session.origin
    const hasContent =
        stored.hasContent === true || session.edited || (origin !== 'new' && origin !== 'continued')
    const edited = stored.edited === true || session.edited
    // The example's order (§1.6.11.3): the session's fields, the flags, then the chain's.
    const {
        edited: _edited,
        hasContent: _hasContent,
        docId: _docId,
        lineageId: _lineageId,
        sourceName: _sourceName,
        ...rest
    } = stored
    return {
        origin,
        ...(session.parent ? { parent: { ...session.parent } } : {}),
        startedAt: session.startedAt,
        ...(edited ? { edited: true } : {}),
        ...(hasContent ? { hasContent: true } : {}),
        chainId: session.chainId,
        docId: session.docId,
        lineageId: session.lineageId,
        ...(session.sourceName === undefined ? {} : { sourceName: session.sourceName }),
        ...rest,
    }
}

const labelOf = (slot: ModelSlot<PendingEntry> | undefined) =>
    typeof slot?.label === 'function' ? slot.label() : (slot?.label ?? '')

/**
 * The journal's stack (§1.6.11.3): the committed slots the live stack still shares, up to the
 * stored window's end, then the head as a new slot unless it's one of them. Without a stored
 * window in a database (a session that never flushed, storage unavailable) `keep` is 0.
 */
export const journalStack = (
    session: FlushSession,
    live: SlotStack<ModelSlot<PendingEntry>>,
): JournalStack => {
    const { committed, window, durable } = session.stack
    let keep = 0
    if (window && durable) {
        // Slots change only by a push, which replaces every slot above it: the shared prefix.
        const end = Math.min(committed.end, live.end, window.base + window.length)
        keep = committed.first
        while (keep < end && live.at(keep) === committed.at(keep)) keep++
        // Slots below the window aren't stored, so they can't be referred to.
        if (keep <= window.base || keep <= live.first) keep = 0
    }
    const head = live.index < keep ? null : { label: labelOf(live.at(live.index)) }
    const dropped: string[] = []
    for (let slot = Math.max(keep, live.first); slot < live.end; slot++)
        if (!(head && slot === live.index)) dropped.push(labelOf(live.at(slot)))
    const lastKept = keep > 0 ? committed.at(keep - 1)?.hash : undefined
    return {
        keep,
        ...(lastKept ? { lastKept: toHex(lastKept) } : {}),
        dropped,
        head,
        index: head ? keep : live.index,
    }
}

/** A whole journal of the session, with `state` as the journalled state. */
export const buildJournal = ({
    session,
    seq,
    live,
    state,
    appVersion,
    writtenAt,
}: {
    session: FlushSession
    seq: number
    live: SlotStack<ModelSlot<PendingEntry>>
    state: State
    appVersion: string
    writtenAt: number
}): JournalV1 => ({
    journalVersion: JOURNAL_VERSION,
    kind: 'journal',
    recordsV: RECORDS_V,
    appVersion,
    writtenAt,
    sessionId: session.id,
    seq,
    descriptor: descriptorOf(session),
    ...journalContent(state),
    stack: journalStack(session, live),
})
