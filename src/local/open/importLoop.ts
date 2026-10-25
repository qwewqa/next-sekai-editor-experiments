import { recordDiagnostic, recordError } from '../../diagnostics'
import { testKeysOpen } from '../../platform/testKeys'
import type { DiskState, LockService } from '../../platform/types'
import { zipFingerprint } from '../../zip/fingerprint'
import { handleOf, readableWithoutPrompt } from '../handles'
import { hasWebLocks, importLock } from '../locks'
import { storedRead } from '../storedRead'
import type { StorageWorker } from '../worker/client'
import type { NotOpened } from '../worker/openHandlers'

// The page's half of an open's background import: it holds `nse-import:<id>`
// (exclusive) and runs the worker's batches one by one, checking the file's fingerprint before
// each and after a hash failure. A change or a read error stops the import (the rows not
// imported become `kept: false`, and the chain stays bound); a hash failure with the fingerprint
// unchanged is damage, which unlinks the chain while the import goes on. A worker restart loses
// the worker's copy of the file: the import reads it again and runs its plan from the start. Saves
// and Check File and History… wait for it (`whenImported`). An import that failed is resumed from
// the file this tab still holds; one no tab holds is resumed by the next load from the bound
// handle, or ended.

/** How an import ended, for a Save that waited for it. */
export type ImportOutcome =
    /** Every batch committed. */
    | { kind: 'done' }
    /** The file turned out damaged: the chain is a separate copy now, and its Save is Save As…. */
    | { kind: 'unlinked'; docId: string }
    /** The file changed or couldn't be read: the rest is `kept: false`, the chain still bound. */
    | { kind: 'stopped' }
    /** Storage failed meanwhile; the next load resumes or ends it. */
    | { kind: 'failed' }
    /** No import ran for that session in this tab. */
    | { kind: 'none' }

/** Where the import reads: the file the open read, and how to check it's unchanged. */
export type ImportSource = {
    file: Blob
    /** The bound handle, to read the file's fingerprint again; none for a picked `File`. */
    handle?: FileSystemFileHandle
    /** The file as read at the open. */
    disk?: DiskState
    revisionId?: string
}

export type ImportJob = {
    worker: Pick<StorageWorker, 'call'>
    locks: LockService
    sessionId: string
    chainId: string
    /** The worker's id of the opened file, and its batch count. */
    id: string
    batches: number
    source: ImportSource
    appVersion: string
    newId?: () => string
    /** The chain unlinked: its new record, after the first damage found. */
    onUnlink?: (record: Record<string, unknown>, first: boolean) => void
    /** The `docId` the chain unlinked as, kept for a later run of the same import. */
    unlinkedAs?: string
}

/** A batch's timeout: a chunks batch inflates and hashes up to 4 MB, on a slow phone too. */
const BATCH_TIMEOUT_MS = 120_000

/** How many times one run reads the file again after a restart before it gives up. */
const MAX_RESUMES = 2

const running = new Map<string, Promise<ImportOutcome>>()

/** Each import this tab started, until it ends other than `failed`: a resume here reads its file. */
const held = new Map<string, ImportJob>()

/** How far an import has come, in batches: what a Save waiting for it shows. */
export type ImportProgress = { done: number; total: number }

const progress = new Map<string, ImportProgress>()
const listeners = new Map<string, Set<(progress: ImportProgress) => void>>()

/** A listener is a UI's: whatever it throws never fails the import. */
const notifyListener = (listener: (progress: ImportProgress) => void, next: ImportProgress) => {
    try {
        listener(next)
    } catch (error) {
        console.error('An import progress listener failed', error)
    }
}

const report = (sessionId: string, next: ImportProgress) => {
    progress.set(sessionId, next)
    for (const listener of [...(listeners.get(sessionId) ?? [])]) notifyListener(listener, next)
}

/**
 * Calls `listener` with the session's import progress now (when one runs) and after each batch;
 * returns the way to stop listening.
 */
export const onImportProgress = (
    sessionId: string,
    listener: (progress: ImportProgress) => void,
) => {
    const set = listeners.get(sessionId) ?? new Set()
    set.add(listener)
    listeners.set(sessionId, set)
    const known = progress.get(sessionId)
    if (known) notifyListener(listener, known)
    return () => {
        set.delete(listener)
        if (!set.size && listeners.get(sessionId) === set) listeners.delete(sessionId)
    }
}

/** A spec slows the import by this many ms a batch, to act while it runs. */
export const IMPORT_DELAY_TEST_KEY = 'nse.test.importDelay'

const testDelay = async () => {
    let ms = 0
    try {
        ms = testKeysOpen ? Number(localStorage.getItem(IMPORT_DELAY_TEST_KEY) ?? 0) : 0
    } catch {
        // No localStorage: no hook.
    }
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms))
}

/** Resolves once the session's import ends in this tab; `none` when none runs here. */
export const whenImported = (sessionId: string, signal?: AbortSignal): Promise<ImportOutcome> => {
    const job = running.get(sessionId)
    if (!job) return Promise.resolve({ kind: 'none' })
    if (!signal) return job
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
        const abort = () => {
            reject(signal.reason as Error)
        }
        signal.addEventListener('abort', abort, { once: true })
        void job.then((outcome) => {
            signal.removeEventListener('abort', abort)
            resolve(outcome)
        })
    })
}

/** Whether this tab runs the session's import now. */
export const isImporting = (sessionId: string) => running.has(sessionId)

/** Whether this tab runs any session's import now: a save picker waits for all of them. */
export const importsRunning = () => running.size > 0

/** Whether the file is the one read at the open: size and time, and with `full` its `<cd>`. */
const unchanged = async (source: ImportSource, full: boolean) => {
    const { handle, disk } = source
    // A picked `File` stands for its own fingerprint; reading it fails once changed.
    if (!handle || !disk) return true
    try {
        const file = await handle.getFile()
        if (file.size !== disk.size || Math.trunc(file.lastModified) !== disk.lastModified)
            return false
        return !full || (await zipFingerprint(file, file.lastModified)) === disk.fingerprint
    } catch {
        return false
    }
}

const NOT_OPENED: NotOpened = { kind: 'notOpened' }

/**
 * A call that a restart cut off answers `fallback`: the new worker has lost the file. A
 * `TimeoutError` is the watchdog's, which restarts the worker.
 */
const unlessRestarted = async <T, F>(call: Promise<T>, fallback: F): Promise<T | F> => {
    try {
        return await call
    } catch (error) {
        if (error instanceof Error && ['WorkerRestartedError', 'TimeoutError'].includes(error.name))
            return fallback
        throw error
    }
}

/** Runs an import's batches; with `reread`, it first reads the file again in the worker. */
const runBatches = async (job: ImportJob, reread = false): Promise<ImportOutcome> => {
    const { worker, sessionId, source } = job
    let { id, batches } = job
    let resumes = 0
    let unlinkAs = job.unlinkedAs
    const stop = async (): Promise<ImportOutcome> => {
        await worker.call('openAbandon', sessionId).catch(() => undefined)
        return { kind: 'stopped' }
    }
    const done = (): ImportOutcome => {
        report(sessionId, { done: batches, total: batches })
        return job.unlinkedAs ? { kind: 'unlinked', docId: job.unlinkedAs } : { kind: 'done' }
    }
    /** Counts a restart; past the bound the import stays pending. */
    const restarted = () => {
        if (resumes === MAX_RESUMES)
            throw new Error('The storage worker restarted too often during an import')
        resumes++
        recordDiagnostic(
            'error',
            `An import read its file again after a storage worker restart (${resumes} of ${MAX_RESUMES})`,
        )
    }
    /** Reads the file again in the worker; false when it changed or can't be read. */
    const readAgain = async (): Promise<boolean> => {
        for (;;) {
            const resumed = await unlessRestarted(
                worker.call(
                    'openResume',
                    {
                        sessionId,
                        file: source.file,
                        ...(source.revisionId ? { revisionId: source.revisionId } : {}),
                        ...(source.disk ? { fingerprint: source.disk.fingerprint } : {}),
                    },
                    { timeoutMs: BATCH_TIMEOUT_MS },
                ),
                NOT_OPENED,
            )
            if (resumed.kind !== 'notOpened') {
                if (resumed.kind !== 'resumed') return false
                ;({ id, batches } = resumed)
                return true
            }
            restarted()
        }
    }
    try {
        if (reread && !(await readAgain())) return await stop()
        for (let n = 0; n < batches; n++) {
            report(sessionId, { done: n, total: batches })
            await testDelay()
            if (!(await unchanged(source, false))) return await stop()
            const outcome = await unlessRestarted(
                worker.call('openBatch', { id, n }, { timeoutMs: BATCH_TIMEOUT_MS }),
                NOT_OPENED,
            )
            if (outcome.kind === 'done') continue
            // After a resume, only this run's own last batch, committed before the restart, ends
            // the import: the lock keeps every other tab out.
            if (outcome.kind === 'gone') return resumes ? done() : { kind: 'stopped' }
            if (outcome.kind === 'readError') return await stop()
            if (outcome.kind === 'damaged') {
                // Only a hash failure with the fingerprint unchanged is damage.
                if (!(await unchanged(source, true))) return await stop()
                unlinkAs ??= (job.newId ?? (() => crypto.randomUUID()))()
                // No record: the worker lost the file (the chain can't go while the lock is held).
                const record = await unlessRestarted(
                    worker.call('openUnlink', {
                        id,
                        chainId: job.chainId,
                        docId: unlinkAs,
                        hashes: outcome.hashes,
                        appVersion: job.appVersion,
                    }),
                    undefined,
                )
                if (record) {
                    const first = job.unlinkedAs === undefined
                    job.unlinkedAs = unlinkAs
                    job.onUnlink?.(record, first)
                    continue
                }
            }
            // A restarted worker lost the file: it is read again, and the new plan runs from the
            // start, since it can differ from the first one. Every batch can run again.
            restarted()
            if (!(await readAgain())) return await stop()
            n = -1
        }
        return done()
    } finally {
        await worker.call('openDrop', id).catch(() => undefined)
    }
}

const track = (sessionId: string, run: Promise<ImportOutcome>) => {
    const job = run.catch((error: unknown): ImportOutcome => {
        recordError(error)
        console.error('The import stopped', error)
        return { kind: 'failed' }
    })
    running.set(sessionId, job)
    void job.then((outcome) => {
        if (outcome.kind !== 'failed') held.delete(sessionId)
        if (running.get(sessionId) === job) {
            running.delete(sessionId)
            progress.delete(sessionId)
        }
    })
    return job
}

/** Starts an open's import, holding its lock; resolves how it ended. */
export const startImport = (job: ImportJob): Promise<ImportOutcome> => {
    held.set(job.sessionId, job)
    return track(
        job.sessionId,
        hasWebLocks()
            ? job.locks.request(importLock(job.sessionId), {}, () => runBatches(job))
            : runBatches(job),
    )
}

/** What a resumed import reads of its chain: the binding's name and `disk`, and the revision. */
export type ImportTarget = {
    file?: { name?: unknown; disk?: DiskState }
    revisionId?: string
}

export type ResumeDeps = Omit<
    ImportJob,
    'id' | 'batches' | 'source' | 'sessionId' | 'chainId' | 'onUnlink'
> & {
    /** A resumed import found damage: the session's chain unlinked. */
    onResumedUnlink?: (
        sessionId: string,
        name: string,
        record: Record<string, unknown>,
        first: boolean,
        kept: { file: Blob; handle: FileSystemFileHandle },
    ) => void
}

/**
 * The resume of each session whose open's import no tab runs and whose import lock is free: from
 * the file this tab holds when this tab started it, else from the bound handle when it reads
 * without a prompt and still is the file opened; otherwise the rows whose states never arrived
 * become `kept: false`. The next load runs it after startup, so a stored handle is never read
 * during startup or recovery.
 */
export const resumeImports = async (deps: ResumeDeps) => {
    const { worker, locks } = deps
    const listed = await storedRead(worker, 'openPendingImports', undefined)
    // A list that can't be read resumes nothing: every import stays pending for the next load.
    if (listed.storedRead === 'failed') return
    // A file held for an import that ended elsewhere, or whose chain was deleted, is let go.
    const pending = new Set(listed.storedValue.map((each) => each.sessionId))
    for (const sessionId of held.keys())
        if (!pending.has(sessionId) && !running.has(sessionId)) held.delete(sessionId)
    for (const { sessionId, chainId } of listed.storedValue) {
        if (running.has(sessionId)) continue
        const own = held.get(sessionId)
        const resume = async (): Promise<ImportOutcome> => {
            if (own) return runBatches(own, true)
            const read = await storedRead(worker, 'openImportTarget', chainId)
            // As an import that threw: it stays pending, and nothing is abandoned.
            if (read.storedRead === 'failed') return { kind: 'failed' }
            const target = read.storedValue
            const disk = target?.file?.disk
            const stored = disk ? await handleOf(worker, chainId, 'file') : undefined
            // A handle that can't be read ends the import as a missing one does, as today (the
            // rows stay in the file, and a write-back append keeps them).
            const handle = stored?.storedRead === 'value' ? stored.storedValue : undefined
            let file: File | undefined
            if (disk && handle && (await readableWithoutPrompt(handle)))
                file = await handle.getFile().catch(() => undefined)
            if (file && handle && disk) {
                const name = typeof target.file?.name === 'string' ? target.file.name : file.name
                const kept = { file, handle }
                // The worker's id and batches come from reading the file again.
                return runBatches(
                    {
                        ...deps,
                        onUnlink: (record, first) => {
                            deps.onResumedUnlink?.(sessionId, name, record, first, kept)
                        },
                        sessionId,
                        chainId,
                        id: '',
                        batches: 0,
                        source: {
                            file,
                            handle,
                            disk,
                            ...(target.revisionId ? { revisionId: target.revisionId } : {}),
                        },
                    },
                    true,
                )
            }
            // Gone or unreadable: the import ends.
            await worker.call('openAbandon', sessionId)
            return { kind: 'stopped' }
        }
        if (!hasWebLocks()) {
            await track(sessionId, resume())
            continue
        }
        // A second tab never resumes an import whose lock is held.
        await locks.request(importLock(sessionId), { ifAvailable: true }, async (granted) => {
            if (!granted) return
            await track(sessionId, resume())
        })
    }
}
