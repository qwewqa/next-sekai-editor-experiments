import {
    checkedSum,
    createRecoveryContext,
    OperationDataError,
    recoverySources,
    type RecoveryContext,
    type StepDescription,
} from '../../history/operations'
import type { State } from '../../state'
import { CHAIN_OWN_FIELDS } from '../chainFields'
import type { FlushSession, PendingEntry } from '../flush'
import { toHex } from '../hash'
import { RECORDS_V, SESSION_V } from '../records/version'
import type { ModelSlot, SlotStack } from '../timeline'
import { journalContent } from './content'
import { JOURNAL_VERSION, type Journal, type JournalDescriptor, type JournalStack } from './format'

// Building a journal from the tab's session: the descriptor from what
// the page knows and the chain record the last flush wrote, the whole state, and the stack by
// reference to what's committed.

const hexOf = (value: unknown) => (value instanceof Uint8Array ? toHex(value) : value)

/** A binding or Export target without its handle, hashes as hex. */
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
    // The session's fields come first, then the flags, then the chain's.
    const {
        edited: _edited,
        hasContent: _hasContent,
        docId: _docId,
        lineageId: _lineageId,
        sourceName: _sourceName,
        ...rest
    } = stored
    return {
        v: SESSION_V,
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

// Flat contexts follow slot occurrences; identical descriptions are never deduplicated.
const contextOf = (live: SlotStack<ModelSlot<PendingEntry>>, keep: number): RecoveryContext => {
    const current = live.at(live.index)
    if (!current) throw new OperationDataError('No journal head')
    const essential = recoverySources(current.step)
    let dropped: StepDescription[] = []
    let headIndex = 0
    let omitted = 0
    const append = (items: readonly StepDescription[], skipped: number) => {
        const sum = checkedSum([omitted, skipped])
        if (sum === undefined) throw new OperationDataError('Recovery count overflow')
        omitted = sum
        dropped.push(...items)
        const excess = Math.max(0, dropped.length - 64)
        if (excess) {
            dropped = dropped.slice(excess)
            headIndex = Math.max(0, headIndex - excess)
            const total = checkedSum([omitted, excess])
            if (total === undefined) throw new OperationDataError('Recovery count overflow')
            omitted = total
        }
    }
    const addSlot = (at: number) => {
        const slot = live.at(at)
        if (!slot) throw new OperationDataError('Missing journal source slot')
        const source = at === live.index ? essential : recoverySources(slot.step)
        if (at === live.index) {
            headIndex = dropped.length + source.headIndex
            append(source.dropped, source.omitted)
        } else {
            const ordered = [...source.dropped]
            ordered.splice(source.headIndex, 0, source.head)
            append(ordered, source.omitted)
        }
    }
    if (live.index < keep) addSlot(live.index)
    for (let at = Math.max(keep, live.first); at < live.end; at++) addSlot(at)
    return createRecoveryContext(essential.head, dropped, headIndex, omitted)
}

/**
 * The journal's stack: the committed slots the live stack still shares, up to the
 * stored window's end, then the head as a new slot unless it's one of them. Without a stored
 * window in a database (a session that never flushed, storage unavailable) `keep` is 0.
 */
export const journalStack = (
    session: FlushSession,
    live: SlotStack<ModelSlot<PendingEntry>>,
): JournalStack => {
    const { committed, durable } = session.stack
    // An unstored continuation's committed slots are its parent's stored window: the
    // replay that applies it as its first write keeps them from there.
    const parentWindow =
        session.continuation && !session.stored && session.forkOf === undefined
            ? { base: committed.first, length: committed.end - committed.first }
            : undefined
    const window = session.stack.window ?? parentWindow
    let keep = 0
    if (window && (durable || parentWindow)) {
        // Slots change only by a push, which replaces every slot above it: the shared prefix.
        const end = Math.min(committed.end, live.end, window.base + window.length)
        keep = committed.first
        while (keep < end && live.at(keep) === committed.at(keep)) keep++
        // Slots below the window aren't stored, so they can't be referred to.
        if (keep <= window.base || keep <= live.first) keep = 0
    }
    const head = live.index >= keep
    const context = contextOf(live, keep)
    const lastKept = keep > 0 ? committed.at(keep - 1)?.hash : undefined
    return {
        keep,
        ...(lastKept ? { lastKept: toHex(lastKept) } : {}),
        context,
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
}): Journal => ({
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
