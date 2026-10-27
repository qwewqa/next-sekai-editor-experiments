import { recordError } from '../../diagnostics'
import type { EndSaveResult, Flusher, SaveEntryInput, SaveReservation } from '../../local/flush'
import type { IdentityUnit } from '../../local/save/commit'
import { FileError, platform, type SaveRequest, type SaveResult } from '../../platform'
import type { State } from '../../state'
import { fileError } from '../commands/exportLevel/errorText'
import { environment, type Env } from './binding'
import type { SaveUi } from './dialogs'
import { removeMarker, savedState, writeMarker, type SaveMarker } from './env'
import { openPreparing, PREPARING_MS, waitForChainImports, type PreparingSlot } from './imports'

// One Save attempt: every Save, Export's pick and Recent Sessions' Save… that may
// write a file runs in one. It owns the Save's cancel and its one "Preparing…", the wait for the chain's
// imports, the reservation and how that reservation ends, and the failure the user is shown. The
// flows own what is built and what is asked; they never end a reservation themselves.

/** A failure before anything was written: a precondition or a denial. */
const notWritten = (failure: FileError) => failure.step === 'check' || failure.code === 'denied'

/** The Save was cancelled in its "Preparing…": thrown at the points a cancel can stop it. */
export class Cancelled extends Error {
    override name = 'Cancelled'
    constructor() {
        super('The Save was cancelled')
    }
}

/**
 * A continuation not stored yet tries to commit its first row before its first file write; when
 * storage fails, the write still goes ahead. Returns false when another session is open after the
 * commit, as when the commit forked the session. Nothing is written for this one then.
 */
export const commitFirst = async (env: Env) => {
    const { session } = env
    if (!session.stored) session.atOnce = true
    await env.flusher.flush({ strict: true })
    return environment()?.session === env.session
}

export type AttemptSpec = {
    /** Undefined only for Export without storage: no commit, wait or reservation. */
    readonly env: Env | undefined
    /** "Preparing <name>…", and the name a throw is shown under. */
    readonly name: string
    readonly surface: 'save' | 'export'
    readonly ui: { preparing: SaveUi['preparing'] }
    readonly commitFirst: boolean
    /** 'chain': waits for every import of the chain, a failed list counting as pending. */
    readonly importWait: 'none' | 'chain'
    /** The chain whose imports are waited for, when it is not the environment's (Recent Sessions' Save…). */
    readonly importChain?: string
    /** A write-back's, requested at the press and awaited after the commit. */
    readonly permission?: Promise<PermissionState>
    /** A large touch download: "Preparing…" opens at once, with this size. */
    readonly estimated?: number
    /** Export's dialog cancel, joined until the commit point. */
    readonly signal?: AbortSignal
}

export type Ending =
    | { readonly kind: 'cancelled' }
    /** The commit forked the session: the caller opens the Save dialog for `environment()`. */
    | { readonly kind: 'forked' }
    | { readonly kind: 'failed'; readonly error: FileError; readonly name: string }

export type Reserved = { readonly reservation: SaveReservation; readonly state: State }

export type SaveAttempt = {
    readonly env: Env | undefined
    readonly signal: AbortSignal
    /** 'unlinked': the open session's own import ended unlinked while the attempt waited. */
    readonly imported: 'done' | 'unlinked'
    /** Throws `Cancelled` once the Save was cancelled, until `commit`. */
    checkpoint(): void
    /**
     * The commit point (a picker returned a file): "Preparing…" closes and no Cancel has any effect
     * from here, neither the dialog's nor the spec's signal. The pick session calls it.
     */
    commit(): void
    /** Closes "Preparing…" and its timer: a picker opens next, on the press. */
    closePreparing(): void
    /**
     * Takes a reservation and the state it saves in, in one step; undefined when none is free. With
     * `wait`, a reservation another flow holds is waited for (never inside a hold of `nse-bind`).
     */
    reserve(wait?: boolean): Promise<Reserved | undefined>
    /** Runs `work`; "Preparing…" opens when it outlasts `PREPARING_MS`. */
    preparing<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T>
    /** The press a lapsed activation needs: false on Cancel. */
    ready(action: 'save' | 'download', size: number): Promise<boolean>
    /**
     * Writes a known file or downloads, and ends the reservation as the landing needs: kept when the
     * write may have landed, let go when it certainly did not. `marker` is written after the build
     * and before the first byte, and removed when the write certainly did not land. A failure is
     * thrown, `Cancelled` for a cancel; a result that is not a landing ends the reservation too.
     */
    write(request: SaveRequest, marker?: () => SaveMarker | undefined): Promise<SaveResult>
    /** Ends the reservation with the Save's entry and binding. */
    complete(
        entry: SaveEntryInput,
        unit: IdentityUnit,
    ): Promise<Exclude<EndSaveResult, 'kept' | 'letGo'>>
}

/** Ends a reservation with its entry: the one call that adds a `save` entry. */
const completeSave = (
    flusher: Flusher,
    reservation: SaveReservation,
    entry: SaveEntryInput,
    unit: IdentityUnit,
) => flusher.endSave(reservation, entry, unit) as Promise<Exclude<EndSaveResult, 'kept' | 'letGo'>>

export const withSaveAttempt = async <T>(
    spec: AttemptSpec,
    body: (attempt: SaveAttempt) => Promise<T>,
): Promise<T | Ending> => {
    const { env } = spec
    const slot: PreparingSlot = {
        name: spec.name,
        ui: spec.ui,
        cancel: new AbortController(),
        ...(spec.surface === 'export' ? { kind: 'export' as const } : {}),
    }
    const { signal } = slot.cancel
    if (spec.signal)
        if (spec.signal.aborted) slot.cancel.abort()
        else
            spec.signal.addEventListener(
                'abort',
                () => {
                    slot.cancel.abort()
                },
                { once: true },
            )
    let imported: 'done' | 'unlinked' = 'done'
    /** Past the commit point: a cancel no longer stops anything. */
    let committed = false
    /** The reservation held now, and whether a write of it started (so it may have landed). */
    let held: SaveReservation | undefined
    let writing = false
    /** A write returned a landing (the file read back as ours, or the download started). */
    const progress = { landed: false }

    const stopped = (error: unknown) =>
        !committed && (error instanceof Cancelled || (signal.aborted && error === signal.reason))
    const disarm = () => {
        clearTimeout(slot.timer)
        slot.timer = undefined
    }
    const arm = () => {
        if (committed) return
        slot.timer ??= setTimeout(() => {
            openPreparing(slot)
        }, PREPARING_MS)
    }
    const closeDialog = () => {
        disarm()
        slot.dialog?.close()
        slot.dialog = undefined
    }
    /** Ends the held reservation: kept when its write may have landed, else let go. */
    const end = async () => {
        const reservation = held
        if (!reservation || !env) return
        await (writing ? env.flusher.release(reservation) : env.flusher.endSave(reservation))
        if (held === reservation) held = undefined
    }

    const attempt: SaveAttempt = {
        env,
        signal,
        get imported() {
            return imported
        },
        checkpoint: () => {
            if (!committed && signal.aborted) throw new Cancelled()
        },
        commit: () => {
            committed = true
            closeDialog()
        },
        closePreparing: closeDialog,
        reserve: async (wait = true) => {
            if (!env) return
            await end()
            for (;;) {
                // The build and the identity are this session's: after any wait, a switch to
                // another session (New, Open) leaves nothing to reserve.
                if (env.flusher.session !== env.session) return
                const reservation = env.flusher.reserveSave()
                if (reservation) {
                    disarm()
                    held = reservation
                    writing = false
                    // In one step: what the Save saves is the state its `seq` was reserved in.
                    return { reservation, state: savedState() }
                }
                // None free: another flow holds it.
                if (!wait || env.session.reserved === undefined) return
                arm()
                await env.flusher.reservationEnded(signal)
                if (signal.aborted) {
                    disarm()
                    return
                }
            }
        },
        preparing: async (work) => {
            arm()
            try {
                return await work(signal)
            } finally {
                disarm()
            }
        },
        ready: async (action, size) => {
            if (signal.aborted) return false
            const dialog = openPreparing(slot)
            const go = await dialog.ready(action, size)
            // The press consumed the dialog.
            dialog.close()
            slot.dialog = undefined
            return go
        },
        write: async (request, marker) => {
            writing = true
            const download = !request.target
            // What the platform's write got to, set by its build (it runs inside `saveFile`).
            const reached: { built: boolean; marker?: SaveMarker } = { built: false }
            // A download has no dialog of its own: its press prompt is `ready`.
            if (!download) arm()
            try {
                const result = await platform.saveFile({
                    ...request,
                    // From the commit point on a cancel cannot stop the write.
                    ...(committed ? {} : { signal }),
                    ...(download && !request.ready
                        ? { ready: (file) => attempt.ready('download', file.size) }
                        : {}),
                    build: async (sources) => {
                        const made = await request.build(sources)
                        // Cancelled while it built: nothing is written, and no marker kept.
                        if (!committed) signal.throwIfAborted()
                        reached.built = true
                        const kept = marker?.()
                        if (kept) {
                            reached.marker = kept
                            writeMarker(kept)
                        }
                        return made
                    },
                })
                closeDialog()
                if (result.status === 'saved' || result.status === 'download-started') {
                    progress.landed = true
                    return result
                }
                writing = false
                await end()
                return result
            } catch (error) {
                closeDialog()
                const failure = error instanceof FileError ? error : undefined
                const cancelled = stopped(error)
                // Once built, a file write may have landed: its `seq` stays for the marker. A
                // cancel is honoured only before the write commits.
                const unwritten =
                    download ||
                    !reached.built ||
                    cancelled ||
                    (failure !== undefined && notWritten(failure))
                if (reached.marker && unwritten)
                    removeMarker(reached.marker.chainId, reached.marker.entry.revisionId)
                writing = !unwritten
                await end()
                throw cancelled ? new Cancelled() : error
            }
        },
        complete: async (entry, unit) => {
            const reservation = held
            if (!reservation || !env) return 'ended'
            try {
                const result = await completeSave(env.flusher, reservation, entry, unit)
                held = undefined
                return result
            } catch (error) {
                // The file holds this write and read back as ours: the Save is shown as done, and
                // its marker stays for the next Save to record. The reservation is still held when
                // the capture threw; the exit lets it go.
                recordError(error)
                return 'ended'
            }
        },
    }

    try {
        if (spec.estimated !== undefined) openPreparing(slot).built(spec.estimated)
        // A continuation's first commit can fork the session, or another session can be open by
        // now: nothing is written, and the Save dialog opens for the one that is.
        if (env && spec.commitFirst && !(await commitFirst(env))) return { kind: 'forked' }
        if (spec.permission) {
            let granted: PermissionState
            try {
                granted = await spec.permission
            } catch {
                granted = 'denied'
            }
            if (granted !== 'granted')
                return {
                    kind: 'failed',
                    error: new FileError('denied', 'Not allowed'),
                    name: spec.name,
                }
        }
        if (env && spec.importWait === 'chain') {
            const waited = await waitForChainImports(
                spec.importChain ? { ...env, chainId: spec.importChain } : env,
                slot,
            )
            // A large download's dialog (opened at once, with its size) stays up through the build.
            if (spec.estimated === undefined) closeDialog()
            if (waited === 'cancelled') return { kind: 'cancelled' }
            imported = waited
        }
        return await body(attempt)
    } catch (error) {
        if (stopped(error)) return { kind: 'cancelled' }
        // The file is written: a throw in the bookkeeping after it is recorded, never shown as a
        // failed write. The marker stays for the next Save to record the binding.
        if (progress.landed) {
            recordError(error)
            console.error('A Save failed', error)
            return { kind: 'cancelled' }
        }
        // Shown as a failure, which records it; logged as a Save's own throw always was.
        console.error('A Save failed', error)
        return { kind: 'failed', error: fileError(error), name: spec.name }
    } finally {
        closeDialog()
        // Whatever the body left held: kept if a write of it started, else let go.
        await end().catch(recordError)
    }
}
