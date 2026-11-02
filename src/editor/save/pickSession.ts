import { i18n } from '../../i18n'
import { importsRunning } from '../../local/open/importLoop'
import {
    FileError,
    platform,
    type DiskState,
    type FileTarget,
    type SavePicker,
    type SaveResult,
} from '../../platform'
import { hasActivation, reportsActivation } from '../../platform/detect'
import { savePoint } from '../../platform/testPause'
import { withBind, type SaveMarker } from './env'
import { pause, PREPARING_MS } from './imports'
import {
    Cancelled,
    withSaveAttempt,
    type AttemptSpec,
    type Ending,
    type SaveAttempt,
} from './saveAttempt'

// The pick session: every save picker opens here, and nowhere else. It
// waits for imports, checks activation last and holds `nse-bind` exclusive after the pick.
// The flows own the output; the session owns the picker and hold.

/** A file failure without a file name takes the picked file's, as a write's does. */
const named = (error: unknown, name: string) =>
    error instanceof FileError && error.fileName === undefined
        ? new FileError(error.code, error.message, error.disk, error.step, name)
        : error

// The session.

/** The project picker: one id, so the browser remembers where it was. */
export const projectPicker = (startIn: SavePicker['startIn'] = 'documents'): SavePicker => ({
    id: 'nse-project',
    types: [{ description: i18n.value.save.fileType, extension: '.nxsp' }],
    excludeAll: true,
    startIn,
})

export type PickSpec = Omit<AttemptSpec, 'importWait' | 'ui'> & {
    /** The chain whose imports are waited for, when it is not the environment's (Recent Sessions' Save…). */
    readonly importChain?: string
    /** Called at the commit point with the destination. */
    readonly committed?: (target: FileTarget & { kind: 'handle' }) => void
    /** A denied Save retries its picked file without opening another picker. */
    readonly target?: FileTarget & { kind: 'handle' }
    readonly ui: AttemptSpec['ui'] & {
        /**
         * Reports a failed write that left the picked file confirmed empty, after the hold. Video
         * has none: it describes its failure once the stream is cleaned up.
         */
        readonly emptied?: (name: string) => Promise<void>
    }
}

export type Dismissed = { readonly kind: 'dismissed' }

export type PickedFile = {
    readonly target: FileTarget & { kind: 'handle' }
    /** Inspected inside the hold: the write's precondition. */
    readonly found: DiskState
    /**
     * Set when the file was written since the pick (a sync client, another tab): the failure the
     * flow ends with, before it revokes or writes anything.
     */
    readonly changed: FileError | undefined
    /** The one write to the picked file, over `found`. A failure is thrown. */
    write(request: {
        kind: 'nxsp' | 'nsld'
        blob: Blob
        marker?: () => SaveMarker | undefined
    }): Promise<SaveResult>
}

export type PickSession = Omit<SaveAttempt, 'write' | 'commit' | 'closePreparing'> & {
    /**
     * Uses the retry destination or opens the picker, then runs `inLock` inside the hold. A failed
     * write reports a confirmed-empty file here. `size` is the built file's, for a lapsed
     * activation's press.
     */
    pick<T>(
        picker: SavePicker,
        suggestedName: string,
        inLock: (picked: PickedFile) => Promise<T>,
        size?: number,
    ): Promise<T | Dismissed | Ending>
    /** A download browser's: no picker here. */
    download(request: { suggestedName: string; blob: Blob }): Promise<SaveResult>
    /** Whether the empty-file warning has already reported the failure. */
    readonly emptied: boolean
}

/** How often a picker waiting for an import running in this tab looks again. */
const LOCAL_POLL_MS = 100

export const withPickSession = <T>(
    spec: PickSpec,
    body: (session: PickSession) => Promise<T | Dismissed | Ending>,
): Promise<T | Dismissed | Ending> => {
    const { env } = spec
    let startedAt = performance.now()
    const attemptSpec: AttemptSpec = {
        env,
        name: spec.name,
        surface: spec.surface,
        ui: { preparing: spec.ui.preparing },
        commitFirst: spec.commitFirst,
        importWait: 'chain',
        ...(spec.importChain ? { importChain: spec.importChain } : {}),
        ...(spec.permission ? { permission: spec.permission } : {}),
        ...(spec.estimated === undefined ? {} : { estimated: spec.estimated }),
        ...(spec.signal ? { signal: spec.signal } : {}),
    }
    return withSaveAttempt(attemptSpec, async (attempt) => {
        let emptied = false

        const quiet = () =>
            attempt.preparing(async (signal) => {
                while (importsRunning() && !signal.aborted) await pause(LOCAL_POLL_MS, signal)
            })

        const lapsed = () =>
            reportsActivation() ? !hasActivation() : performance.now() - startedAt > PREPARING_MS

        /** Runs `inLock` under `nse-bind` exclusive, then reports a confirmed-empty file. */
        const hold = async <R>(
            target: FileTarget & { kind: 'handle' },
            inLock: (picked: PickedFile) => Promise<R>,
        ): Promise<R> => {
            const name = target.handle.name
            let result: R | undefined
            let failure: { error: unknown } | undefined
            let landed = false
            await withBind('exclusive', async () => {
                let found: DiskState | undefined
                try {
                    const disk = await platform.inspect(target, 'nxsp')
                    if (disk === 'missing')
                        throw new FileError(
                            'not-found',
                            `${name} cannot be found`,
                            undefined,
                            undefined,
                            name,
                        )
                    found = disk
                } catch (error) {
                    failure = { error }
                }
                if (found && !failure) {
                    const disk = found
                    const picked: PickedFile = {
                        target,
                        found: disk,
                        changed:
                            disk.size === 0
                                ? undefined
                                : new FileError('conflict', `${name} changed`, disk, 'check', name),
                        write: async (request) => {
                            // The empty file as this write's kind measures it.
                            const expected =
                                request.kind === 'nxsp'
                                    ? disk
                                    : await platform.inspect(target, request.kind)
                            if (expected === 'missing')
                                throw new FileError(
                                    'not-found',
                                    `${name} cannot be found`,
                                    undefined,
                                    undefined,
                                    name,
                                )
                            // Every pick must still be empty, whatever output is being written.
                            if (expected.size !== 0)
                                throw new FileError(
                                    'conflict',
                                    `${name} changed`,
                                    expected,
                                    'check',
                                    name,
                                )
                            const written = await attempt.write(
                                {
                                    kind: request.kind,
                                    suggestedName: name,
                                    target,
                                    expected,
                                    build: () =>
                                        Promise.resolve({ kind: 'blob', blob: request.blob }),
                                },
                                request.marker,
                            )
                            if (written.status === 'saved') landed = true
                            return written
                        },
                    }
                    try {
                        result = await inLock(picked)
                    } catch (error) {
                        failure = { error }
                    }
                }
                if (landed || !spec.ui.emptied) return
                const now = await platform.read(target).catch(() => undefined)
                emptied = now?.size === 0
            })
            if (emptied) await spec.ui.emptied?.(name)
            if (failure) throw named(failure.error, name)
            return result as R
        }

        const session: PickSession = {
            env,
            signal: attempt.signal,
            get imported() {
                return attempt.imported
            },
            get emptied() {
                return emptied
            },
            checkpoint: () => {
                attempt.checkpoint()
            },
            reserve: (wait) => attempt.reserve(wait),
            preparing: (work) => attempt.preparing(work),
            ready: (action, size) => attempt.ready(action, size),
            complete: (entry, unit) => attempt.complete(entry, unit),
            download: ({ suggestedName, blob }) =>
                attempt.write({
                    kind: 'nxsp',
                    suggestedName,
                    build: () => Promise.resolve({ kind: 'blob', blob }),
                }),
            pick: async (picker, suggestedName, inLock, size = 0) => {
                const open = platform.pickSaveFile
                if (!open) throw new FileError('io', 'There is no save picker')
                attempt.checkpoint()
                // A press just answered is an activation: it is asked for once, and again only
                // after another wait.
                let pressed = false
                for (;;) {
                    attempt.checkpoint()
                    // Wait for imports before the picker can empty their source file.
                    if (importsRunning()) {
                        await quiet()
                        pressed = false
                        continue
                    }
                    // A wait that outlasted the press asks for a new one.
                    if (!spec.target && !pressed && lapsed()) {
                        if (!(await attempt.ready('save', size))) throw new Cancelled()
                        startedAt = performance.now()
                        pressed = true
                        continue
                    }
                    break
                }
                // The activation check was the last step: only microtasks until the picker opens.
                attempt.closePreparing()
                const target = spec.target ?? (await open({ suggestedName, picker }))
                if (target?.kind !== 'handle') return { kind: 'dismissed' }
                // The commit point: no Cancel has any effect from here.
                attempt.commit()
                spec.committed?.(target)
                await savePoint('picked')
                const result = await hold(target, inLock)
                return result
            },
        }

        return body(session)
    })
}
