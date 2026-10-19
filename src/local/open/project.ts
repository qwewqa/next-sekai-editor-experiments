import {
    exportMemory,
    KEPT_BYTES_LIMIT,
    rememberExport,
} from '../../editor/commands/exportLevel/memory'
import { LOAD_ORDER } from '../../editor/loadOrder'
import { addLoadNotice, notify } from '../../editor/notification'
import { type JsonValue } from '../../history/operations'
import { session as currentSession } from '../../history/session'
import { isPeeking, liveState, replaceState } from '../../history/stack'
import { i18n } from '../../i18n'
import type { State } from '../../state'
import type { Bgm } from '../../state/bgm'
import { interpolate } from '../../utils/interpolate'
import type { ChainSummary } from '../flushWrite'
import { handleOf, storableHandle } from '../handles'
import { hasWebLocks, sessionLock } from '../locks'
import { placedCompleteFrom } from '../nxsp/project'
import { holdSessionLock } from '../sessions'
import { sessionContext } from '../startup/api'
import { openStored } from '../startup/open'
import { writeTabRecord } from '../startup/tab'
import type { StateBatch } from '../stateBatch'
import { flusher, journalWriter } from '../storing'
import type { EarlierChain } from './decide'
import { resumeImports, startImport, type ImportOutcome } from './importLoop'
import { keepCopy } from './kept'
import type { OpenReadReply } from './opened'

// The page's side of opening a `.nxsp` (Part 1 §1.5.4 step 3 on): the new chain and session stored
// at once in the worker's first transaction, then opened in this tab as a stored session is, its
// background import started, and the chain's identity updated in this tab when damage unlinks it.

export type NxspReply = OpenReadReply & { kind: 'nxsp' }

export { KEPT_BYTES_LIMIT }

const context = () => {
    const found = sessionContext()
    if (!found) throw new Error('Startup has not opened storage yet')
    return found
}

/** A picked file's worker read; the worker keeps a `.nxsp` under the reply's id. */
export const readProjectFile = (file: File) =>
    context().open.worker.call('openRead', file, { timeoutMs: 120_000 })

/** Forgets a read the user cancelled. */
export const dropProjectRead = (id: string) => {
    void context()
        .open.worker.call('openDrop', id)
        .catch(() => undefined)
}

/**
 * Whether another tab's open session is bound to this file (§1.3.2, `isSameEntry`): such an open
 * is a separate copy.
 */
export const boundInAnotherTab = async (handle: FileSystemFileHandle) => {
    const { open } = context()
    if (!hasWebLocks()) return false
    try {
        const own = await open.client.id()
        const snapshot = await open.locks.query()
        const others = snapshot.held
            .filter((lock) => lock.name.startsWith('nse-session:'))
            .filter((lock) => own === undefined || lock.clientId !== own)
            .map((lock) => lock.name.slice('nse-session:'.length))
        if (!others.length) return false
        for (const { chainId } of await open.worker.call('readBindings', others)) {
            const other = await handleOf(open.worker, chainId, 'file')
            if (other && (await other.isSameEntry(handle).catch(() => false))) return true
        }
    } catch {
        // Where the browser can't tell, the open binds; Save's own check guards the file.
    }
    return false
}

/** The chains this browser has on the document, as the open's notice reads them (§1.5.4). */
export const earlierChains = async (docId: string, exclude: string): Promise<EarlierChain[]> => {
    const { open, recovery } = context()
    const stored = await open.worker.call('openEarlierChains', { docId, exclude })
    // A dead tab's pending journal holds changes storage doesn't: Restore applies it first.
    const journals = new Set(
        (await recovery.journal.read().catch(() => [])).map((found) => found.sessionId),
    )
    return Promise.all(
        stored.map(async (chain) => ({
            ...chain,
            changed: chain.changed || (!!chain.bound && journals.has(chain.sessionId)),
            openElsewhere:
                hasWebLocks() &&
                (await open.client.heldElsewhere(sessionLock(chain.sessionId)).catch(() => false)),
        })),
    )
}

export type StoreOpen = {
    read: NxspReply
    file: File
    handle?: FileSystemFileHandle
    /** Bound to the file: a whole open, not open in another tab. */
    bind?: { name: string; options: { history: boolean; bgm: boolean } }
    /** Takes the file's identity: a whole open (§1.3.3); otherwise a new `docId` and no revision. */
    identity: boolean
    /** The live state when it isn't the history's head. */
    level?: StateBatch
    summary?: ChainSummary
    /** "Separate copy of …": a partial open, or the same file open in another tab. */
    copyOf?: { name: string; bound: true }
    sourceName: string
    operations: { opened: JsonValue; changedOutside: JsonValue }
    appVersion: string
    newId?: () => string
}

export type StoredOpen = {
    sessionId: string
    chainId: string
    state: State
    import?: Promise<ImportOutcome>
}

const isEmpty = (value: object) => !Object.keys(value).length

/** The chain record's identity and names from `project.json` (§1.5.4 step 6). */
const chainFields = async (open: StoreOpen) => {
    const { project, extra, disk } = open.read
    const fields: Record<string, unknown> = { sourceName: open.sourceName }
    if (project?.name !== undefined) fields.name = project.name
    if (project?.exportName !== undefined) fields.exportName = project.exportName
    if (!isEmpty(extra)) fields.extra = extra
    const revision = open.identity ? project?.revision : undefined
    if (revision)
        fields.revision = { id: revision.id, n: revision.n, ancestors: revision.ancestors }
    if (!open.identity) fields.partialImport = true
    if (open.bind && revision !== undefined) {
        const handle = await storableHandle(open.handle)
        const completeFrom = placedCompleteFrom(revision)
        fields.file = {
            name: open.bind.name,
            ...(handle ? { handle } : {}),
            event: 'opened',
            ...(completeFrom === undefined ? {} : { completeFrom }),
            ...(disk ? { disk } : {}),
            options: open.bind.options,
        }
    } else if (open.bind) {
        // A file from before revisions: bound, and its next write starts the ancestry.
        const handle = await storableHandle(open.handle)
        fields.file = {
            name: open.bind.name,
            ...(handle ? { handle } : {}),
            event: 'opened',
            ...(disk ? { disk } : {}),
            options: open.bind.options,
        }
    }
    return fields
}

/**
 * Stores the open (its first transaction), then opens the new session in this tab, as a reload
 * resumes one, and starts the background import. The session left is offered by Reopen.
 */
export const storeAndShow = async (open: StoreOpen): Promise<StoredOpen> => {
    const { open: deps } = context()
    const newId = open.newId ?? (() => crypto.randomUUID())
    const { project } = open.read
    const sessionId = newId()
    const chainId = newId()
    const docId = open.identity && project ? project.id : newId()
    const lineageId = project?.lineageId ?? newId()
    const lock = holdSessionLock(deps.locks, sessionId)
    let shown = false
    try {
        await lock.granted.catch(() => undefined)
        const stored = await deps.worker.call(
            'openStore',
            {
                id: open.read.id,
                ids: { chainId, sessionId, docId, lineageId },
                chain: await chainFields(open),
                ...(open.level ? { level: open.level } : {}),
                ...(open.summary ? { summary: open.summary } : {}),
                operations: open.operations,
                wall: Date.now(),
                appVersion: open.appVersion,
            },
            { timeoutMs: 120_000 },
        )
        if (stored.kind !== 'stored') throw new Error('The opened file is no longer read')
        const read = await deps.worker.call('readSession', sessionId)
        if (read.kind !== 'open') throw new Error(`The opened session is ${read.kind}`)
        const leaving = flusher?.session
        // The BGM's "not loaded" is the open's own notice to give (§1.6.8.4), never a load notice.
        const quiet = {
            ...deps,
            events: (event: Parameters<typeof deps.events>[0]) => {
                if (event.kind !== 'bgmNotLoaded') deps.events(event)
            },
        }
        const state = await openStored(quiet, read, { mode: 'resume', lock }, { replace: true })
        if (!state) throw new Error('The opened session did not open')
        shown = true
        if (leaving && flusher) deps.onLeft?.(leaving, flusher.outgoing)
        if (open.copyOf) {
            currentSession.value = { ...currentSession.value, copyOf: open.copyOf }
            writeTabRecord({ sessionId, start: 'stored', copyOf: open.copyOf })
        }
        keepOpenedBytes(open, chainId, !open.bind)
        const job =
            stored.batches > 0
                ? startImport({
                      worker: deps.worker,
                      locks: deps.locks,
                      sessionId,
                      chainId,
                      id: open.read.id,
                      batches: stored.batches,
                      source: {
                          file: open.file,
                          ...(open.handle ? { handle: open.handle } : {}),
                          ...(open.read.disk ? { disk: open.read.disk } : {}),
                          ...(project?.revision ? { revisionId: project.revision.id } : {}),
                      },
                      appVersion: open.appVersion,
                      newId,
                      onUnlink: (record, first) => {
                          unlinked(open, sessionId, record, first)
                      },
                  })
                : undefined
        return { sessionId, chainId, state, ...(job ? { import: job } : {}) }
    } finally {
        if (!shown) lock.release()
    }
}

/** What Replace keeps first (§1.4.7): the version on disk, read whole, as an unbound session. */
export type KeepVersion = {
    read: NxspReply
    file: Blob
    sourceName: string
    /** "Coconut (replaced Oct 16)". */
    name: string
    level?: StateBatch
    summary?: ChainSummary
    operations: { opened: JsonValue; changedOutside: JsonValue }
    appVersion: string
}

/**
 * Stores the version on disk as a new, unbound, ordinary session in Recent Sessions (§1.4.7
 * Replace, Part 0 §0.9.6): its first transaction, then its history's batches, each committed
 * strictly, under the new session's lock. True only when all of it is stored: Replace writes
 * nothing otherwise.
 */
export const storeKept = async (keep: KeepVersion) => {
    const { open: deps } = context()
    const { project } = keep.read
    if (!project) return false
    const sessionId = crypto.randomUUID()
    const chainId = crypto.randomUUID()
    const lock = holdSessionLock(deps.locks, sessionId)
    try {
        await lock.granted.catch(() => undefined)
        const chain: Record<string, unknown> = { sourceName: keep.sourceName, name: keep.name }
        if (project.exportName !== undefined) chain.exportName = project.exportName
        if (!isEmpty(keep.read.extra)) chain.extra = keep.read.extra
        const { revision } = project
        if (revision)
            chain.revision = { id: revision.id, n: revision.n, ancestors: revision.ancestors }
        const stored = await deps.worker.call(
            'openStore',
            {
                id: keep.read.id,
                ids: { chainId, sessionId, docId: project.id, lineageId: project.lineageId },
                chain,
                origin: 'replaced',
                ...(keep.level ? { level: keep.level } : {}),
                ...(keep.summary ? { summary: keep.summary } : {}),
                operations: keep.operations,
                wall: Date.now(),
                appVersion: keep.appVersion,
            },
            { timeoutMs: 120_000 },
        )
        if (stored.kind !== 'stored') return false
        if (!stored.batches) return true
        const outcome = await startImport({
            worker: deps.worker,
            locks: deps.locks,
            sessionId,
            chainId,
            id: keep.read.id,
            batches: stored.batches,
            source: { file: keep.file },
            appVersion: keep.appVersion,
        })
        return outcome.kind === 'done'
    } catch {
        return false
    } finally {
        lock.release()
    }
}

/**
 * The bytes read at the open, kept with its handle (§1.5.4, D5, D26): a save picker that empties a
 * file the editor won't write over puts them back, after a reload too.
 */
const keepOpenedBytes = (open: StoreOpen, chainId: string, keep: boolean) => {
    if (open.handle) keepBytes(open.file, open.handle, chainId, keep)
}

const keepBytes = (file: Blob, handle: FileSystemFileHandle, chainId: string, keep: boolean) => {
    exportMemory.opened = {
        handle,
        levelData: false,
        partial: keep,
        project: true,
        ...(keep ? { keptCopy: keepCopy(context().open.worker, chainId, file, handle) } : {}),
    }
}

/**
 * Damage found after the open unlinked the chain (§1.6.11.8): when the session is open in this
 * tab it takes the new identity, its journal is written again with it (r12-freeze item 2), its
 * label reads "Separate copy of …", and the file's bytes are kept for a picker that would empty
 * it. The notice comes with the first damage found.
 */
const unlinkedSession = (
    sessionId: string,
    name: string,
    record: Record<string, unknown>,
    first: boolean,
    resumed: boolean,
    kept?: { file: Blob; handle: FileSystemFileHandle },
) => {
    const docId = record.docId
    if (typeof docId !== 'string') return
    const session = flusher?.session
    if (session?.id === sessionId) {
        session.docId = docId
        session.chain = record
        journalWriter?.rewrite()
    }
    if (currentSession.value.sessionId === sessionId) {
        const { file: _bound, ...rest } = currentSession.value
        const copyOf = { name, bound: true }
        currentSession.value = { ...rest, docId, copyOf }
        writeTabRecord({ sessionId, start: 'stored', copyOf })
        exportMemory.partial = true
        void rememberExport()
        const chainId = record.chainId
        if (kept && typeof chainId === 'string') keepBytes(kept.file, kept.handle, chainId, true)
    }
    if (!first) return
    // Its notice: a card after an open, a load notice after a resume (§1.4.3).
    const message = interpolate(() => i18n.value.open.damagedHistory, name)
    if (resumed) addLoadNotice(message, undefined, LOAD_ORDER.damagedHistory)
    else notify(message, { card: true })
}

const unlinked = (
    open: StoreOpen,
    sessionId: string,
    record: Record<string, unknown>,
    first: boolean,
) => {
    unlinkedSession(
        sessionId,
        open.bind?.name ?? open.file.name,
        record,
        first,
        false,
        open.handle ? { file: open.file, handle: open.handle } : undefined,
    )
}

/**
 * After startup, an open's import a tab didn't finish is resumed from the bound handle, or ended
 * (§1.5.4): never during startup or recovery, so a stored handle is read only here (D16).
 */
export const resumeAfterStartup = (appVersion: string) => {
    const { open: deps } = context()
    const run = () => {
        void resumeImports({
            worker: deps.worker,
            locks: deps.locks,
            appVersion,
            onResumedUnlink: (sessionId, name, record, first, kept) => {
                unlinkedSession(sessionId, name, record, first, true, kept)
            },
        }).catch((error: unknown) => {
            console.error('An unfinished import could not be resumed', error)
        })
    }
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2000 })
    else setTimeout(run, 0)
}

/**
 * The opened file's BGM, decoded in the background (§1.5.4 step 5, §1.6.8.4): attached to the
 * live state when it still names it. Nothing is pushed: the state is the same.
 */
export const attachOpenedBgm = async (
    bytes: Blob,
    hash: string,
    decode: (data: ArrayBuffer) => Promise<Partial<Bgm>>,
) => {
    const data = await bytes.arrayBuffer()
    const source = data.slice(0)
    const decoded = await decode(data)
    const live = liveState.value
    // A peek holds its own state: the live one isn't replaced under it.
    if (isPeeking.value || live.bgm.meta?.hash !== hash || live.bgm.buffer) return false
    replaceState({ ...live, bgm: { ...live.bgm, ...decoded, source } })
    return true
}
