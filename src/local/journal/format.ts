import { captureRecoveryContext, type RecoveryContext } from '../../history/operations'
import type { JournalLike } from '../../platform/types'
import { isHash16Hex } from '../hash'
import { isNewerSessionVersion } from '../records/unknownValues'
import { RECORDS_V, SESSION_V } from '../records/version'

// The structured journal: the object a `journal.<sessionId>` key holds,
// and the checks a reader makes before it trusts one. A newer journal is left in place for a
// later build; one this build can't read keeps its bytes in the `recovered` store.

/** The writer's own journal version. */
export const JOURNAL_VERSION = 1

/** Group, stage and folder ids in level-data entity order. */
export type JournalIds = {
    groups: number[]
    stages: number[]
    groupFolders: number[]
    stageFolders: number[]
}

/** The stack the journalled state sits in. */
export type JournalStack = {
    /** Slots `0 … keep − 1` of the committed stack stay. */
    keep: number
    /** The hash of slot `keep − 1` as committed, as hex; absent when `keep` is 0. */
    lastKept?: string
    /** True when the journalled state becomes a new slot at keep. */
    head: boolean
    /** Descriptions survive even when the committed prefix is unavailable at recovery. */
    context: RecoveryContext
    index: number
}

/**
 * The session descriptor: the session's `v?`, `origin`, `parent?` and `startedAt`,
 * then the chain record as it was at this write without handles, hashes as hex, every field a
 * fork copies kept by value.
 */
export type JournalDescriptor = {
    v: number
    origin: string
    parent?: { id: string; uptoSeq: number }
    startedAt: number
    edited?: true
    hasContent?: true
    chainId: string
    docId: string
    lineageId: string
} & Record<string, unknown>

export type Journal = {
    journalVersion: number
    kind: 'journal'
    recordsV: number
    appVersion: string
    writtenAt: number
    sessionId: string
    seq: number
    descriptor: JournalDescriptor
    /** `serializeToLevelData`'s output with folders, gzipped at level 1, in base64. */
    levelDataGz: string
    editorMetadata?: { defaultGuideColors?: number[] }
    /** The header's `levelInfo` and `bgm` records and the ids. */
    header: { levelInfo: unknown[]; bgm?: unknown[]; ids: JournalIds }
    stack: JournalStack
}

/** What a reader makes of a journal's text. */
export type JournalReading =
    | { kind: 'journal'; journal: Journal }
    /** Written by a newer build: left in place. */
    | { kind: 'later'; why: string }
    /** Not a journal this build can read: its bytes go to the `recovered` store. */
    | { kind: 'unreadable'; why: string }

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const isCount = (value: unknown): value is number =>
    Number.isSafeInteger(value) && (value as number) >= 0

const isIdList = (value: unknown): value is number[] =>
    Array.isArray(value) && value.every((id) => Number.isSafeInteger(id))

export const trimOptionalJournalContext = (value: JournalLike): JournalLike | undefined => {
    const raw: unknown = value
    if (!isObject(raw) || raw.journalVersion !== JOURNAL_VERSION || !isObject(raw.stack)) return
    let context: RecoveryContext | undefined
    try {
        context = captureRecoveryContext(raw.stack.context)
    } catch {
        return
    }
    if (!context.dropped.length || context.omitted === Number.MAX_SAFE_INTEGER) return
    const trimmed = {
        ...value,
        stack: {
            ...raw.stack,
            context: {
                head: context.head,
                headIndex: Math.max(0, context.headIndex - 1),
                dropped: context.dropped.slice(1),
                omitted: context.omitted + 1,
            },
        },
    }
    return trimmed
}

/** Reads a journal's text; `sessionId` is the one its key names. */
export const readJournal = (text: string, sessionId: string): JournalReading => {
    let value: unknown
    try {
        value = JSON.parse(text)
    } catch {
        return { kind: 'unreadable', why: 'not JSON' }
    }
    if (!isObject(value)) return { kind: 'unreadable', why: 'not an object' }
    const unreadable = (why: string): JournalReading => ({ kind: 'unreadable', why })

    // Newer first: a later build's journal is never moved aside, whatever else it holds.
    const { journalVersion, kind, recordsV, descriptor } = value
    if (!Number.isSafeInteger(journalVersion) || (journalVersion as number) < JOURNAL_VERSION)
        return unreadable('no journalVersion')
    if ((journalVersion as number) > JOURNAL_VERSION)
        return { kind: 'later', why: `journalVersion ${String(journalVersion)}` }
    if (kind !== 'journal') return { kind: 'later', why: `kind ${String(kind)}` }
    if (!Number.isSafeInteger(recordsV) || (recordsV as number) < 1)
        return unreadable('no recordsV')
    if ((recordsV as number) > RECORDS_V)
        return { kind: 'later', why: `recordsV ${String(recordsV)}` }
    if (!isObject(descriptor)) return unreadable('no descriptor')
    if (isNewerSessionVersion(descriptor.v))
        return { kind: 'later', why: `unsupported descriptor v ${String(descriptor.v)}` }
    if (descriptor.v !== SESSION_V)
        return unreadable(`unsupported descriptor v ${String(descriptor.v)}`)

    if (value.sessionId !== sessionId) return unreadable('another session’s key')
    if (!isCount(value.seq) || value.seq < 1) return unreadable('no seq')
    if (typeof value.appVersion !== 'string' || typeof value.writtenAt !== 'number')
        return unreadable('no writer')
    for (const field of ['chainId', 'docId', 'lineageId', 'origin'] as const)
        if (typeof descriptor[field] !== 'string') return unreadable(`no descriptor ${field}`)
    if (typeof descriptor.startedAt !== 'number') return unreadable('no descriptor startedAt')
    const { parent } = descriptor
    if (
        parent !== undefined &&
        !(isObject(parent) && typeof parent.id === 'string' && isCount(parent.uptoSeq))
    )
        return unreadable('a bad descriptor parent')
    if (typeof value.levelDataGz !== 'string') return unreadable('no levelDataGz')
    const { editorMetadata } = value
    if (
        editorMetadata !== undefined &&
        !(
            isObject(editorMetadata) &&
            (editorMetadata.defaultGuideColors === undefined ||
                (Array.isArray(editorMetadata.defaultGuideColors) &&
                    editorMetadata.defaultGuideColors.every(isCount)))
        )
    )
        return unreadable('bad editorMetadata')
    const { header } = value
    if (!isObject(header) || !Array.isArray(header.levelInfo)) return unreadable('no header')
    if (header.bgm !== undefined && !Array.isArray(header.bgm))
        return unreadable('a bad header bgm')
    const { ids } = header
    if (
        !isObject(ids) ||
        !isIdList(ids.groups) ||
        !isIdList(ids.stages) ||
        !isIdList(ids.groupFolders) ||
        !isIdList(ids.stageFolders)
    )
        return unreadable('no header ids')
    const { stack } = value
    if (!isObject(stack) || !isCount(stack.keep) || !isCount(stack.index))
        return unreadable('no stack')
    if (stack.keep > 0 ? !isHash16Hex(stack.lastKept) : stack.lastKept !== undefined)
        return unreadable('a bad stack lastKept')
    try {
        captureRecoveryContext(stack.context)
    } catch {
        return unreadable('a bad stack context')
    }
    const { head } = stack
    if (head === false) {
        if (stack.index >= stack.keep) return unreadable('a committed head outside keep')
    } else if (head !== true || stack.index !== stack.keep) return unreadable('a bad stack head')
    return { kind: 'journal', journal: value as Journal }
}
