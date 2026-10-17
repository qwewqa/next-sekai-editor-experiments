import type { JournalFound } from '../../platform/types'
import type { State } from '../../state'
import type { SessionOrigin } from '../flushWrite'
import { journalState } from '../journal/content'
import { readJournal } from '../journal/format'

// A same-tab reload while storage is unavailable (Part 1 §1.6.7): the page is still its session,
// so it continues from its own journal, keeping the session's ids and descriptor, and goes on
// writing that key. Pure, so the Node tests run it.

/** The tab's session as its own journal holds it. */
export type JournalledSession = {
    id: string
    chainId: string
    docId: string
    lineageId: string
    origin: SessionOrigin
    startedAt: number
    parent?: { id: string; uptoSeq: number }
    name?: string
    sourceName?: string
    /** The journal's newest `seq`: the next entry follows it. */
    seq: number
    /** The descriptor's chain fields, which the next journal carries on. */
    chain: Record<string, unknown>
    state: State
    /** The head slot's label. */
    label: string
}

const SESSION_FIELDS = new Set(['v', 'origin', 'parent', 'startedAt'])

const text = (value: unknown) => (typeof value === 'string' ? value : undefined)

/** The session in this tab's own journal, or undefined when this build can't load it. */
export const journalledSession = (found: JournalFound): JournalledSession | undefined => {
    const reading = readJournal(found.text, found.sessionId)
    if (reading.kind !== 'journal') return
    const content = journalState(reading.journal)
    if (content.kind !== 'state') return
    const { journal } = reading
    const { descriptor } = journal
    const chain: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(descriptor))
        if (!SESSION_FIELDS.has(key)) chain[key] = value
    const name = text(descriptor.name)
    const sourceName = text(descriptor.sourceName)
    return {
        id: found.sessionId,
        chainId: descriptor.chainId,
        docId: descriptor.docId,
        lineageId: descriptor.lineageId,
        origin: descriptor.origin as SessionOrigin,
        startedAt: descriptor.startedAt,
        ...(descriptor.parent ? { parent: descriptor.parent } : {}),
        ...(name === undefined ? {} : { name }),
        ...(sourceName === undefined ? {} : { sourceName }),
        seq: journal.seq,
        chain,
        state: content.state,
        label: journal.stack.head?.label ?? '',
    }
}
