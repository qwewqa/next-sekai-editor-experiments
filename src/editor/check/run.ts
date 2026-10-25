import { recordError } from '../../diagnostics'
import { stackGeneration } from '../../history/stack'
import { i18n } from '../../i18n'
import type { CheckedMedia } from '../../local/check/finish'
import { requestRead } from '../../local/handles'
import { hasWebLocks, MAINT_LOCK } from '../../local/locks'
import type { MediaKind } from '../../local/nxsp/read'
import type { ModelRefusal } from '../../local/save/model'
import { readValue, storedRead } from '../../local/storedRead'
import { platform, type DiskState } from '../../platform'
import { nxspDiskState, sameContent } from '../../platform/fingerprint'
import { savePoint } from '../../platform/testPause'
import { isSafeMode } from '../../safe'
import { interpolate } from '../../utils/interpolate'
import { bindingHandle, environment, quickBinding, type Env } from '../save/binding'
import { readDiskFacts } from '../save/disk'
import { waitForChainImports, type PreparingSlot } from '../save/imports'
import { enqueueSave } from '../save/queue'
import { unlinkSession } from '../save/unlink'
import { refusalLine, reportLines, type CheckText, type Findings } from './report'

// Check File and History… on the page: which file, then the
// run inside the Save queue: the wait for the chain's imports, `nse-maint` shared from there to
// the finish, the file read in full, the stored history, and the finish with the worker's repair,
// marks and media removal. The unlink of a damaged file follows. Cancel works until the finish
// starts, and a session switch cancels like it.

/** The file to check in full: the bound file as the binding holds it. */
type BoundFile = {
    handle: FileSystemFileHandle
    /** The snapshot read at the press: a change after it makes a read fail. */
    found: File
    /** The binding's disk state: the fingerprint the file must still have. */
    disk: DiskState
}

export type Plan = {
    env: Env
    /** The name in messages: the bound file's, else the displayed name. */
    name: string
    /** Set when the file is checked in full. */
    file?: BoundFile
    /** Why the file is not checked, when a reason applies. */
    reason?: () => string
}

export type CheckOutcome =
    | { kind: 'cancelled' }
    /** Replaces the report: a failure line. */
    | { kind: 'failed'; message: () => string }
    /** `problems`: it repaired or found damage (for the usage statistics). */
    | { kind: 'report'; lines: (() => string)[]; problems: boolean }

const cancelled: CheckOutcome = { kind: 'cancelled' }

const storageFailed = (): CheckOutcome => ({
    kind: 'failed',
    message: () => i18n.value.notice.storageUnavailable,
})

const changedFailure = (name: string): CheckOutcome => ({
    kind: 'failed',
    message: interpolate(() => i18n.value.check.changed, name),
})

/** A chain this build cannot judge ends the run with its own line, not the storage one. */
const refusedFailure = (reason: ModelRefusal, name: string): CheckOutcome => ({
    kind: 'failed',
    message: refusalLine(reason, name, checkText),
})

/** Ends the run with this outcome from any depth. */
class End extends Error {
    constructor(readonly outcome: CheckOutcome) {
        super('The check ended')
        this.name = 'End'
    }
}

// Which file (decided at the press, before the run waits for anything).

const readFailedLine = (name: string) => interpolate(() => i18n.value.save.readFailed, name)

/** The line for a file that is not the one bound: a newer version of it, or a changed one. */
const changedLine = async (env: Env, name: string, found: File, disk: DiskState) => {
    try {
        const facts = await readDiskFacts(found)
        if (facts.projectJson !== undefined) {
            const read = await storedRead(env.worker, 'replaceDecision', {
                chainId: env.chainId,
                projectJson: facts.projectJson,
                fingerprint: disk.fingerprint,
            })
            if (read.storedRead === 'value' && read.storedValue?.relation === 'newer')
                return interpolate(() => i18n.value.state.newerOnDiskName, name)
        }
    } catch {
        // What is on disk cannot be told apart: it counts as changed.
    }
    return interpolate(() => i18n.value.state.changedOnDiskName, name)
}

/**
 * Decides which file the run checks, on the press: read access is asked for here, so the browser
 * can prompt. The bound file is checked only when it still has the fingerprint the binding holds;
 * otherwise only the stored history is, with a reason line where one applies. A download binding
 * or unbound work has none. Returns undefined when storage cannot say (a failed read).
 */
export const planCheck = async (env: Env, shownName: string): Promise<Plan | undefined> => {
    const binding = quickBinding(env)
    const file = binding.file
    if (!file || binding.replaced) return { env, name: shownName }
    const name = file.name
    const read = platform.pickSaveFile ? await bindingHandle(env, file) : readValue(undefined)
    if (read.storedRead === 'failed') return undefined
    const handle = read.storedValue
    if (!handle) return { env, name }
    if (!(await requestRead(handle))) return { env, name, reason: readFailedLine(name) }
    let found: File
    let disk: DiskState
    try {
        found = await handle.getFile()
        disk = await nxspDiskState(found, found.lastModified)
    } catch {
        return { env, name, reason: readFailedLine(name) }
    }
    if (!file.disk || !sameContent(disk, file.disk))
        return { env, name, reason: await changedLine(env, name, found, disk) }
    return { env, name, file: { handle, found, disk: file.disk } }
}

// The run.

/** Holds `nse-maint` shared until the returned function is called (a no-op without Web Locks). */
const holdMaint = (signal: AbortSignal) =>
    new Promise<() => void>((resolve) => {
        const none = () => undefined
        if (!hasWebLocks()) {
            resolve(none)
            return
        }
        // The lock's callback runs once granted; the release is handed out from it.
        platform.locks
            .request(
                MAINT_LOCK,
                { mode: 'shared', signal },
                () =>
                    new Promise<void>((release) => {
                        resolve(release)
                    }),
            )
            .catch(() => {
                resolve(none)
            })
    })

const percent = (done: number, total: number) =>
    total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 100

type Say = (message: () => string) => void

const fileMessage = (name: string, done: number, total: number) =>
    interpolate(() => i18n.value.check.checkingFile, name, String(percent(done, total)))

const storedMessage = (done: number, total: number) =>
    interpolate(() => i18n.value.check.checkingStored, String(percent(done, total)))

/** The dialog's first message, before the run has started. */
export const firstMessage = (plan: Plan): (() => string) =>
    plan.file ? fileMessage(plan.name, 0, 1) : storedMessage(0, 1)

/** A "Preparing…" that shows nothing: the progress dialog is the run's. */
const silentPreparing = (signal: AbortSignal): ReturnType<PreparingSlot['ui']['preparing']> => ({
    signal,
    importing: () => undefined,
    built: () => undefined,
    ready: () => Promise.resolve(false),
    close: () => undefined,
})

/** The strings of the report, each named where it is read. */
const checkText = (): CheckText => {
    const { check, open, load, save } = i18n.value
    return {
        check: {
            noDamage: check.noDamage,
            fileDamaged: check.fileDamaged,
            repaired: check.repaired,
            storedDamaged: check.storedDamaged,
            mediaDamaged: check.mediaDamaged,
            scopeBoth: check.scopeBoth,
            scopeStored: check.scopeStored,
        },
        media: open.media,
        refusal: { later: load.sessionLater, unreadable: save.readFailed },
    }
}

/** The options an open's file read takes (`readProjectFile`). */
const FILE_CALL = { timeoutMs: 120_000 }

const perform = async (
    plan: Plan,
    signal: AbortSignal,
    say: Say,
    held: { release?: () => void; ids: Set<string> },
): Promise<CheckOutcome> => {
    const { env, name } = plan
    const generation = stackGeneration()
    const switched = () =>
        environment()?.session !== env.session || stackGeneration() !== generation
    const stop = () => signal.aborted || switched()
    const checkpoint = () => {
        if (stop()) throw new End(cancelled)
    }
    checkpoint()

    // 2. The chain's open imports: rows not imported yet never count.
    const wait = new AbortController()
    const forward = () => {
        wait.abort()
    }
    signal.addEventListener('abort', forward, { once: true })
    let importUnlinked: boolean
    try {
        const waited = await waitForChainImports(
            env,
            {
                name,
                ui: { preparing: () => silentPreparing(wait.signal) },
                cancel: wait,
            },
            undefined,
        )
        if (waited === 'cancelled') throw new End(cancelled)
        importUnlinked = waited === 'unlinked'
    } finally {
        signal.removeEventListener('abort', forward)
    }
    checkpoint()
    const pending = await storedRead(env.worker, 'openPendingImports', undefined)
    if (pending.storedRead === 'failed') throw new End(storageFailed())
    if (pending.storedValue.some((each) => each.chainId === env.chainId))
        throw new End({
            kind: 'failed',
            message: interpolate(() => i18n.value.check.stillOpening, name),
        })

    // 3. `nse-maint` shared from here to the finish: deleters back off.
    held.release = await holdMaint(signal)
    checkpoint()

    // 4. The file phase.
    let fileDamaged = importUnlinked
    let fileChecked = false
    let reason = plan.reason
    if (plan.file && !importUnlinked) {
        const bound = plan.file
        say(fileMessage(name, 0, 1))
        let opened
        try {
            opened = await env.worker.call('checkFileOpen', bound.found, FILE_CALL)
        } catch (error) {
            recordError(error)
            opened = { kind: 'newer' as const }
        }
        switch (opened.kind) {
            case 'readError':
                throw new End(changedFailure(name))
            case 'newer':
                reason = readFailedLine(name)
                break
            case 'damaged':
                fileDamaged = true
                fileChecked = true
                break
            case 'read': {
                held.ids.add(opened.id)
                let done = 0
                let unreadable = false
                for (let n = 0; n < opened.batches; n++) {
                    checkpoint()
                    say(fileMessage(name, done, opened.bytes))
                    let batch
                    try {
                        batch = await env.worker.call('checkFileBatch', { id: opened.id, n })
                    } catch (error) {
                        recordError(error)
                        unreadable = true
                        break
                    }
                    if (batch.kind === 'readError') throw new End(changedFailure(name))
                    if (batch.kind === 'notOpened') {
                        unreadable = true
                        break
                    }
                    done += batch.bytes
                    if (batch.bad.length) fileDamaged = true
                }
                held.ids.delete(opened.id)
                void env.worker.call('checkDrop', opened.id).catch(() => undefined)
                if (unreadable) reason = readFailedLine(name)
                else fileChecked = true
                break
            }
        }
    }

    // 5. The stored phase.
    let storedId: string | undefined
    const opened = await storedRead(env.worker, 'checkStoredOpen', env.chainId)
    if (opened.storedRead === 'failed') throw new End(storageFailed())
    if (opened.storedValue.kind === 'refused')
        throw new End(refusedFailure(opened.storedValue.reason, name))
    if (opened.storedValue.kind === 'opened') {
        const stored = opened.storedValue
        storedId = stored.id
        held.ids.add(stored.id)
        let done = 0
        for (let n = 0; n < stored.batches; n++) {
            checkpoint()
            say(storedMessage(done, stored.roots))
            const batch = await storedRead(env.worker, 'checkStoredBatch', { id: stored.id, n })
            if (batch.storedRead === 'failed') throw new End(storageFailed())
            if (batch.storedValue.kind === 'refused')
                throw new End(refusedFailure(batch.storedValue.reason, name))
            if (batch.storedValue.kind !== 'done') throw new End(storageFailed())
            done += batch.storedValue.roots
        }
        say(storedMessage(stored.roots, stored.roots))
    }
    checkpoint()

    // 6. The finish: no Cancel from here. The file's fingerprint is read again; a change writes
    // nothing. The shared hold goes first, as the media removal takes it exclusive.
    let useFile: File | undefined
    if (plan.file && !importUnlinked) {
        const bound = plan.file
        try {
            const found = await bound.handle.getFile()
            const disk = await nxspDiskState(found, found.lastModified)
            if (!sameContent(disk, bound.disk)) throw new End(changedFailure(name))
        } catch (error) {
            if (error instanceof End) throw error
            throw new End(changedFailure(name))
        }
        useFile = bound.found
    }
    held.release()
    held.release = undefined
    let repaired = 0
    let damaged = 0
    let media: CheckedMedia[] = []
    let readOnly = isSafeMode()
    if (storedId !== undefined) {
        const id = storedId
        let finished
        try {
            finished = await env.worker.call('checkFinish', {
                id,
                ...(useFile ? { file: useFile } : {}),
            })
        } catch (error) {
            recordError(error)
            throw new End(storageFailed())
        }
        held.ids.delete(id)
        if (finished.kind === 'refused') throw new End(refusedFailure(finished.reason, name))
        if (finished.kind !== 'done') throw new End(storageFailed())
        // Rows that could not be marked would be called damaged without being so.
        if (finished.markFailed) throw new End(storageFailed())
        repaired = finished.repaired
        damaged = finished.damaged
        media = finished.media
        readOnly = finished.readOnly
        // The Timeline's rows read their flags again (repaired or newly marked).
        if (repaired || finished.marked) void refreshTimeline()
    }

    // 7. A damaged file unlinks the session (not in ?safe): storage holds every state it gave.
    if (fileDamaged && !readOnly && !importUnlinked && !switched()) await unlinkSession(env, name)

    const found: Findings = {
        ...(fileChecked ? { file: { name } } : {}),
        ...(fileDamaged ? { fileDamaged: { name } } : {}),
        ...(reason ? { reason } : {}),
        repaired,
        damaged,
        media: media.map((each) => each.kinds as readonly MediaKind[]),
    }
    return {
        kind: 'report',
        lines: reportLines(found, checkText),
        problems: repaired > 0 || damaged > 0 || fileDamaged,
    }
}

/** Reads the Timeline's newest page again, and the pages loaded before it. */
const refreshTimeline = async () => {
    try {
        const { refresh } = await import('../history/source')
        await refresh({ replace: true })
    } catch (error) {
        recordError(error)
    }
}

/**
 * Runs the check inside the Save queue: after every Save pressed before it, and before any pressed
 * after. `say` receives the progress message. The outcome is never a throw.
 */
export const startCheck = (plan: Plan, signal: AbortSignal, say: Say): Promise<CheckOutcome> => {
    return new Promise((resolve) => {
        void enqueueSave(async () => {
            const held: { release?: () => void; ids: Set<string> } = { ids: new Set() }
            try {
                resolve(await perform(plan, signal, say, held))
            } catch (error) {
                if (error instanceof End) resolve(error.outcome)
                else {
                    recordError(error)
                    resolve(storageFailed())
                }
            } finally {
                held.release?.()
                for (const id of held.ids)
                    void plan.env.worker.call('checkDrop', id).catch(() => undefined)
                await savePoint('checkEnd')
            }
        })
    })
}
