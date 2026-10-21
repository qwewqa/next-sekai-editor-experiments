import { recordError } from '../../diagnostics'
import {
    exportMemory,
    KEPT_BYTES_LIMIT,
    rememberExport,
} from '../../editor/commands/exportLevel/memory'
import { LOAD_ORDER } from '../../editor/loadOrder'
import { addLoadNotice, notify } from '../../editor/notification'
import type { SwitchRequest } from '../../editor/switchRequest'
import type { JsonValue } from '../../history/operations'
import { session as currentSession } from '../../history/session'
import { isPeeking, liveState, replaceState } from '../../history/stack'
import { i18n } from '../../i18n'
import type { State } from '../../state'
import type { Bgm } from '../../state/bgm'
import { interpolate } from '../../utils/interpolate'
import { releaseWaveform } from '../../waveform'
import type { ChainSummary } from '../flushWrite'
import { storableHandle } from '../handles'
import { hasWebLocks, sessionLock } from '../locks'
import { placedCompleteFrom } from '../nxsp/project'
import { holdSessionLock } from '../sessions'
import { sessionContext } from '../startup/api'
import { fileBoundIn, openStored, sessionsHeldElsewhere } from '../startup/open'
import { writeTabRecord } from '../startup/tab'
import type { StateBatch } from '../stateBatch'
import { readValue, storedRead, type StoredRead } from '../storedRead'
import { flusher, journalWriter } from '../storing'
import { changedOf, type EarlierChain } from './decide'
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

const reads = new Map<string, ReturnType<typeof context>>()

/** The read keeps its original worker, even if startup context is replaced. */
export const readProjectFile = async (file: File) => {
    const owner = context()
    const result = await owner.open.worker.call('openRead', file, { timeoutMs: 120_000 })
    if (result.kind === 'nxsp') reads.set(result.id, owner)
    return result
}

const takeRead = (id: string) => {
    const owner = reads.get(id)
    if (!owner) throw new Error('The opened read has no owner')
    reads.delete(id)
    return owner
}

export const dropProjectRead = (id: string) => {
    const owner = reads.get(id)
    if (!owner) return
    reads.delete(id)
    void owner.open.worker.call('openDrop', id).catch(() => undefined)
}

/** Whether another tab's open session is bound to the file: `unknown` when that can't be told. */
export type BoundElsewhere = 'yes' | 'no' | 'unknown'

/**
 * Whether another tab's open session is bound to this file (§1.3.2, `isSameEntry`): such an open
 * is a separate copy, and so is one that can't be told apart (`unknown`: a failed read, a handle
 * this page can't hold, or a throw), which the notice says with "may".
 */
export const boundInAnotherTab = async (handle: FileSystemFileHandle): Promise<BoundElsewhere> => {
    const { open } = context()
    if (!hasWebLocks()) return 'no'
    try {
        const others = await sessionsHeldElsewhere(open)
        if (!others.length) return 'no'
        const bindings = await storedRead(open.worker, 'readBindings', others)
        if (bindings.storedRead === 'failed') return 'unknown'
        return await fileBoundIn(
            open.worker,
            bindings.storedValue.map(({ chainId }) => chainId),
            handle,
        )
    } catch {
        // Uncertain ownership opens a separate copy, and says so.
        return 'unknown'
    }
}

/** The chains this browser has on the document, as the open's notice reads them (§1.5.4). */
export const earlierChains = async (
    docId: string,
    exclude: string,
): Promise<StoredRead<EarlierChain[]>> => {
    const { open, recovery } = context()
    const read = await storedRead(open.worker, 'openEarlierChains', { docId, exclude })
    // The failure goes to the open, which still succeeds and says so.
    if (read.storedRead === 'failed') return read
    const stored = read.storedValue
    // A dead tab's pending journal holds changes storage doesn't: Restore applies it first. When
    // the journals cannot be read, a bound chain that looks unchanged has unknown changes.
    const journals = await recovery.journal
        .read()
        .then((found) => new Set(found.map((each) => each.sessionId)))
        .catch(() => undefined)
    return readValue(
        await Promise.all(
            stored.map(async (chain) => ({
                ...chain,
                changed: changedOf(chain, journals),
                openElsewhere:
                    hasWebLocks() &&
                    (await open.client
                        .heldElsewhere(sessionLock(chain.sessionId))
                        .catch(() => false)),
            })),
        ),
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

export type StoredOpen =
    | { kind: 'cancelled' }
    | {
          kind: 'stored'
          sessionId: string
          chainId: string
          shown: boolean
          state?: State
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
export const storeAndShow = async (
    open: StoreOpen,
    request: SwitchRequest,
): Promise<StoredOpen> => {
    const owner = takeRead(open.read.id)
    const { open: deps } = owner
    const newId = open.newId ?? (() => crypto.randomUUID())
    const { project } = open.read
    const sessionId = newId()
    const chainId = newId()
    const docId = open.identity && project ? project.id : newId()
    const lineageId = project?.lineageId ?? newId()
    const lock = holdSessionLock(deps.locks, sessionId)
    const ownership = { transferred: false }
    let job: Promise<ImportOutcome> | undefined
    let kept: Promise<Blob | undefined> | undefined
    let damaged: { record: Record<string, unknown>; first: boolean } | undefined
    const retainBytes = () => {
        if (open.handle)
            kept ??= keepCopy(deps.worker, chainId, open.file, open.handle).catch(() => undefined)
        return kept
    }
    const applyDamage = (record: Record<string, unknown>, first: boolean) => {
        const copy = retainBytes()
        unlinkedSession(
            sessionId,
            open.bind?.name ?? open.file.name,
            record,
            first,
            false,
            open.handle
                ? { file: open.file, handle: open.handle, ...(copy ? { copy } : {}) }
                : undefined,
            () => ownership.transferred && request.isCurrent(),
        )
    }
    try {
        await lock.granted
        const chain = await chainFields(open)
        if (!request.isCurrent() || sessionContext() !== owner) return { kind: 'cancelled' }
        const stored = await deps.worker.call(
            'openStore',
            {
                id: open.read.id,
                ids: { chainId, sessionId, docId, lineageId },
                chain,
                ...(open.level ? { level: open.level } : {}),
                ...(open.summary ? { summary: open.summary } : {}),
                operations: open.operations,
                wall: Date.now(),
                appVersion: open.appVersion,
            },
            { timeoutMs: 120_000 },
        )
        if (stored.kind !== 'stored') throw new Error('The opened file is no longer read')
        if (!open.bind) void retainBytes()
        if (stored.batches > 0)
            job = startImport({
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
                    damaged = { record, first }
                    applyDamage(record, first)
                },
            })
        if (job) request.retainUntil(job)
        let state: State | undefined
        if (request.isCurrent() && sessionContext() === owner) {
            const read = await deps.worker.call('readSession', sessionId)
            if (read.kind !== 'open') throw new Error(`The opened session is ${read.kind}`)
            const quiet = {
                ...deps,
                events: (event: Parameters<typeof deps.events>[0]) => {
                    if (event.kind !== 'bgmNotLoaded') deps.events(event)
                },
            }
            state = await openStored(
                quiet,
                read,
                { mode: 'resume', lock },
                {
                    replace: true,
                    request,
                    canShow: () => sessionContext() === owner,
                    onTransferred: () => {
                        ownership.transferred = true
                    },
                    onShown: (leaving) => {
                        if (leaving)
                            deps.onLeft?.(
                                leaving,
                                deps.flusher()?.outgoing ?? Promise.resolve(false),
                            )
                    },
                    onDestination: () => {
                        if (open.copyOf) {
                            currentSession.value = { ...currentSession.value, copyOf: open.copyOf }
                            writeTabRecord({ sessionId, start: 'stored', copyOf: open.copyOf })
                        }
                        if (open.handle)
                            exportMemory.opened = {
                                handle: open.handle,
                                levelData: false,
                                partial: !open.bind,
                                project: true,
                                ...(kept ? { keptCopy: kept } : {}),
                            }
                        if (damaged) applyDamage(damaged.record, damaged.first)
                    },
                },
            )
        }
        return {
            kind: 'stored',
            sessionId,
            chainId,
            shown: ownership.transferred,
            ...(state ? { state } : {}),
            ...(job ? { import: job } : {}),
        }
    } finally {
        // A lock no session took is kept until the import's batches and the kept copy settle.
        if (lock.state === 'held') await job
        if (lock.state === 'held') await kept
        if (!job) await deps.worker.call('openDrop', open.read.id).catch(() => undefined)
        else
            void job.finally(() =>
                deps.worker.call('openDrop', open.read.id).catch(() => undefined),
            )
        // The opened session took it, or it goes now.
        lock.release()
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
    const { open: deps } = takeRead(keep.read.id)
    const { project } = keep.read
    if (!project) {
        await deps.worker.call('openDrop', keep.read.id).catch(() => undefined)
        return false
    }
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
        await deps.worker.call('openDrop', keep.read.id).catch(() => undefined)
        lock.release()
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
    kept?: { file: Blob; handle: FileSystemFileHandle; copy?: Promise<Blob | undefined> },
    canNotify: () => boolean = () => true,
) => {
    const docId = record.docId
    if (typeof docId !== 'string') return
    const chainId = record.chainId
    const copy =
        kept && typeof chainId === 'string'
            ? (kept.copy ?? keepCopy(context().open.worker, chainId, kept.file, kept.handle))
            : undefined
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
        if (kept)
            exportMemory.opened = {
                handle: kept.handle,
                levelData: false,
                partial: true,
                project: true,
                ...(copy ? { keptCopy: copy } : {}),
            }
    }
    if (!first || !canNotify() || (!resumed && currentSession.value.sessionId !== sessionId)) return
    // Its notice: a card after an open, a load notice after a resume (§1.4.3).
    const message = interpolate(() => i18n.value.open.damagedHistory, name)
    if (resumed) addLoadNotice(message, undefined, LOAD_ORDER.damagedHistory, 'warning')
    else notify(message, { card: true, severity: 'warning' })
}

/**
 * Resumes the open's imports no tab runs, from the bound handle, or ends them (§1.5.4): what the
 * next load does after startup, and what a Save's wait for the chain's imports does for one that
 * nothing runs. It skips an import this tab runs and one whose lock another tab holds.
 */
export const resumeUnfinishedImports = (appVersion: string) => {
    const { open: deps } = context()
    return resumeImports({
        worker: deps.worker,
        locks: deps.locks,
        appVersion,
        onResumedUnlink: (sessionId, name, record, first, kept) => {
            unlinkedSession(sessionId, name, record, first, true, kept)
        },
    }).catch((error: unknown) => {
        recordError(error)
        console.error('An unfinished import could not be resumed', error)
    })
}

/**
 * After startup, an open's import a tab didn't finish is resumed from the bound handle, or ended
 * (§1.5.4): never during startup or recovery, so a stored handle is read only here (D16).
 */
export const resumeAfterStartup = (appVersion: string) => {
    const run = () => {
        void resumeUnfinishedImports(appVersion)
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
    destination: string,
) => {
    const data = await bytes.arrayBuffer()
    const source = data.slice(0)
    const decoded = await decode(data)
    const live = liveState.value
    // A peek holds its own state: the live one isn't replaced under it.
    if (
        currentSession.value.sessionId !== destination ||
        isPeeking.value ||
        live.bgm.meta?.hash !== hash ||
        live.bgm.buffer
    ) {
        releaseWaveform(decoded.waveform)
        return false
    }
    replaceState({ ...live, bgm: { ...live.bgm, ...decoded, source } })
    return true
}
