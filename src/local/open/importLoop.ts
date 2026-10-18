import type { DiskState, LockService } from '../../platform/types'
import { zipFingerprint } from '../../zip/fingerprint'
import { handleOf, readableWithoutPrompt } from '../handles'
import { hasWebLocks, importLock } from '../locks'
import type { StorageWorker } from '../worker/client'

// The page's half of an open's background import (Part 1 §1.5.4): it holds `nse-import:<id>`
// (exclusive) and runs the worker's batches one by one, checking the file's fingerprint before
// each and after a hash failure. A change or a read error stops the import (the rows not
// imported become `kept: false`, and the chain stays bound); a hash failure with the fingerprint
// unchanged is damage, which unlinks the chain (§1.6.11.8) while the import goes on. Saves and
// Check File and History… wait for it (`whenImported`); the next load resumes one a tab didn't
// finish, from the bound handle, or ends it.

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
    /** The chain unlinked (§1.6.11.8): its new record, after the first damage found. */
    onUnlink?: (record: Record<string, unknown>, first: boolean) => void
}

/** A batch's timeout: a chunks batch inflates and hashes up to 4 MB, on a slow phone too. */
const BATCH_TIMEOUT_MS = 120_000

const running = new Map<string, Promise<ImportOutcome>>()

/** A spec slows the import by this many ms a batch, to act while it runs (§1.11's test hooks). */
export const IMPORT_DELAY_TEST_KEY = 'nse.test.importDelay'

const testDelay = async () => {
    let ms = 0
    try {
        ms = Number(localStorage.getItem(IMPORT_DELAY_TEST_KEY) ?? 0)
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

/** Whether any tab holds the session's import lock: Delete Sessions… skips it (§1.5.4). */
export const importHeld = async (locks: LockService, sessionId: string) => {
    if (!hasWebLocks()) return running.has(sessionId)
    try {
        const snapshot = await locks.query()
        return snapshot.held.some((lock) => lock.name === importLock(sessionId))
    } catch {
        return running.has(sessionId)
    }
}

/** Whether the file is the one read at the open: size and time, and with `full` its `<cd>`. */
const unchanged = async (source: ImportSource, full: boolean) => {
    const { handle, disk } = source
    // A picked `File` stands for its own fingerprint (§1.5.4); reading it fails once changed.
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

const runBatches = async (job: ImportJob): Promise<ImportOutcome> => {
    const { worker, sessionId, source } = job
    let id = job.id
    let unlinkedAs: string | undefined
    const stop = async (): Promise<ImportOutcome> => {
        await worker.call('openAbandon', sessionId).catch(() => undefined)
        return { kind: 'stopped' }
    }
    for (let n = 0; n < job.batches; n++) {
        await testDelay()
        if (!(await unchanged(source, false))) return stop()
        let outcome = await worker.call('openBatch', { id, n }, { timeoutMs: BATCH_TIMEOUT_MS })
        if (outcome.kind === 'notOpened') {
            // A restarted worker: the file is read again, under the same plan.
            const resumed = await worker.call(
                'openResume',
                {
                    sessionId,
                    file: source.file,
                    ...(source.revisionId ? { revisionId: source.revisionId } : {}),
                    ...(source.disk ? { fingerprint: source.disk.fingerprint } : {}),
                },
                { timeoutMs: BATCH_TIMEOUT_MS },
            )
            if (resumed.kind !== 'resumed') return stop()
            id = resumed.id
            outcome = await worker.call('openBatch', { id, n }, { timeoutMs: BATCH_TIMEOUT_MS })
        }
        switch (outcome.kind) {
            case 'done':
                continue
            case 'gone':
                return { kind: 'stopped' }
            case 'notOpened':
            case 'readError':
                return stop()
            case 'damaged': {
                // Only a hash failure with the fingerprint unchanged is damage (r12-freeze2 S8).
                if (!(await unchanged(source, true))) return stop()
                const first = unlinkedAs === undefined
                unlinkedAs ??= (job.newId ?? (() => crypto.randomUUID()))()
                const record = await worker.call('openUnlink', {
                    id,
                    chainId: job.chainId,
                    docId: unlinkedAs,
                    hashes: outcome.hashes,
                    appVersion: job.appVersion,
                })
                if (record) job.onUnlink?.(record, first)
                continue
            }
        }
    }
    await worker.call('openDrop', id).catch(() => undefined)
    return unlinkedAs ? { kind: 'unlinked', docId: unlinkedAs } : { kind: 'done' }
}

const track = (sessionId: string, run: Promise<ImportOutcome>) => {
    const job = run.catch((error: unknown): ImportOutcome => {
        console.error('The import stopped', error)
        return { kind: 'failed' }
    })
    running.set(sessionId, job)
    void job.then(() => {
        if (running.get(sessionId) === job) running.delete(sessionId)
    })
    return job
}

/** Starts an open's import, holding its lock; resolves how it ended. */
export const startImport = (job: ImportJob): Promise<ImportOutcome> =>
    track(
        job.sessionId,
        hasWebLocks()
            ? job.locks.request(importLock(job.sessionId), {}, () => runBatches(job))
            : runBatches(job),
    )

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
 * The next load's resume (§1.5.4): for each session whose open's import a tab didn't finish and
 * whose import lock is free, from the bound handle when it reads without a prompt and still is
 * the file opened; otherwise the rows whose states never arrived become `kept: false`. Runs after
 * startup, so a stored handle is never read during startup or recovery (D16, D24).
 */
export const resumeImports = async (deps: ResumeDeps) => {
    const { worker, locks } = deps
    const pending = await worker.call('openPendingImports')
    for (const { sessionId, chainId } of pending) {
        if (running.has(sessionId)) continue
        const resume = async (): Promise<ImportOutcome> => {
            const target = await worker.call('openImportTarget', chainId)
            const disk = target?.file?.disk
            const handle = disk && (await handleOf(worker, chainId, 'file'))
            if (disk && handle && (await readableWithoutPrompt(handle))) {
                try {
                    const file = await handle.getFile()
                    const resumed = await worker.call(
                        'openResume',
                        {
                            sessionId,
                            file,
                            ...(target.revisionId ? { revisionId: target.revisionId } : {}),
                            fingerprint: disk.fingerprint,
                        },
                        { timeoutMs: BATCH_TIMEOUT_MS },
                    )
                    const name =
                        typeof target.file?.name === 'string' ? target.file.name : file.name
                    if (resumed.kind === 'resumed')
                        return await runBatches({
                            ...deps,
                            onUnlink: (record, first) => {
                                deps.onResumedUnlink?.(sessionId, name, record, first, {
                                    file,
                                    handle,
                                })
                            },
                            sessionId,
                            chainId,
                            id: resumed.id,
                            batches: resumed.batches,
                            source: {
                                file,
                                handle,
                                disk,
                                ...(target.revisionId ? { revisionId: target.revisionId } : {}),
                            },
                        })
                } catch {
                    // Gone or unreadable: the import ends below.
                }
            }
            await worker.call('openAbandon', sessionId)
            return { kind: 'stopped' }
        }
        if (!hasWebLocks()) {
            await track(sessionId, resume())
            continue
        }
        // A second tab never resumes an import whose lock is held.
        await locks.request(importLock(sessionId), { ifAvailable: true }, async (held) => {
            if (!held) return
            await track(sessionId, resume())
        })
    }
}
