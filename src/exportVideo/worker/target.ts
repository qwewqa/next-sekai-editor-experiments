import { isRefusedRead } from '../../platform/fingerprint'
import { fileErrorOf } from '../../platform/handover'
import { FileError } from '../../platform/types'
type VideoPick = { handle: FileSystemFileHandle; lastModified?: number }

export type PositionTarget = {
    write(data: Uint8Array<ArrayBuffer>, position: number): Promise<void>
    close(): Promise<void>
    abort(): Promise<void>
}

export type SyncAccess = {
    write(data: Uint8Array<ArrayBuffer>, options: { at: number }): number
    truncate(size: number): void
    flush(): void
    close(): void
}

type Backend = Omit<PositionTarget, 'close'> & { close(commit: () => void): Promise<void> }

const cancelled = () => new DOMException('Video export cancelled', 'AbortError')

/** Serializes writes and cleanup. Cancellation stops further writes and releases the handle. */
const target = (backend: Backend, signal?: AbortSignal): PositionTarget => {
    let ended = false
    let closing = false
    let stopped = signal?.aborted ?? false
    let queue = Promise.resolve()
    let cleanup: Promise<void> | undefined
    const detach = () => signal?.removeEventListener('abort', onAbort)
    const discard = () => {
        detach()
        return (cleanup ??= Promise.resolve()
            .then(() => backend.abort())
            .catch((error: unknown) => {
                throw fileErrorOf(error)
            })
            .finally(() => {
                ended = true
            }))
    }
    const enqueue = (run: () => Promise<void>) => {
        const next = queue.then(run)
        queue = next.catch(() => undefined)
        return next
    }
    const operation = (run: () => Promise<void>) =>
        enqueue(async () => {
            if (ended && cleanup) await cleanup
            try {
                if (stopped) throw cancelled()
                if (ended) throw new Error('Video target is closed')
                await run()
            } catch (error) {
                if (!ended) await discard()
                if (stopped) throw cancelled()
                throw fileErrorOf(error)
            }
        })
    const abort = () => {
        if (!closing) stopped = true
        return enqueue(async () => {
            if (!ended) await discard()
            else await cleanup
        })
    }
    const onAbort = () => {
        void abort().catch(() => undefined)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    return {
        write: (data, position) =>
            operation(async () => {
                if (
                    !Number.isSafeInteger(position) ||
                    position < 0 ||
                    !Number.isSafeInteger(position + data.length)
                )
                    throw new Error('Invalid video write position')
                await backend.write(data, position)
                if (stopped) throw cancelled()
            }),
        close: () =>
            operation(async () => {
                await backend.close(() => {
                    if (stopped) throw cancelled()
                    closing = true
                    detach()
                })
                ended = true
                detach()
            }),
        abort,
    }
}

/** Seen written since the pick: not empty, or with a time other than the one recorded. */
const changed = (file: File, pick: VideoPick) =>
    file.size !== 0 || (pick.lastModified !== undefined && file.lastModified !== pick.lastModified)

/**
 * Removes the picked file only when it is known to be empty and unchanged: a file found changed,
 * unreadable, or picked without a recorded time is left alone. A refused read is ignored, so
 * it never replaces the original failure.
 */
export const removeVideoPick = async (pick: VideoPick) => {
    let file: File
    try {
        file = await pick.handle.getFile()
    } catch (error) {
        if (error instanceof DOMException && error.name === 'NotFoundError') return
        if (isRefusedRead(error)) return
        throw fileErrorOf(error)
    }
    if (pick.lastModified === undefined || changed(file, pick)) return
    try {
        await (pick.handle as FileSystemFileHandle & { remove(): Promise<void> }).remove()
    } catch (error) {
        const failure = fileErrorOf(error)
        throw new FileError(
            failure.code,
            `${pick.handle.name} was left empty`,
            undefined,
            undefined,
            pick.handle.name,
        )
    }
}

export const openPickedTarget = async (
    pick: VideoPick,
    signal?: AbortSignal,
): Promise<PositionTarget> => {
    const named = (error: unknown) => {
        const failure = fileErrorOf(error)
        return new FileError(
            failure.code,
            failure.message,
            failure.disk,
            failure.step,
            pick.handle.name,
        )
    }
    let writable: FileSystemWritableFileStream
    try {
        signal?.throwIfAborted()
        writable = await pick.handle.createWritable({ keepExistingData: false })
    } catch (error) {
        await removeVideoPick(pick)
        if (signal?.aborted) throw cancelled()
        throw named(error)
    }
    const output = target(
        {
            write: async (data, position) => {
                try {
                    await writable.write({ type: 'write', position, data })
                } catch (error) {
                    throw named(error)
                }
            },
            close: async (commit) => {
                try {
                    // A file the platform refuses to read is not observed: the pick
                    // authorizes the commit.
                    const file = await pick.handle.getFile().catch((error: unknown) => {
                        if (isRefusedRead(error)) return undefined
                        throw error
                    })
                    signal?.throwIfAborted()
                    if (file && changed(file, pick))
                        throw new FileError(
                            'conflict',
                            `${pick.handle.name} changed`,
                            undefined,
                            'check',
                            pick.handle.name,
                        )
                    commit()
                    await writable.close()
                } catch (error) {
                    if (signal?.aborted) throw cancelled()
                    throw named(error)
                }
            },
            abort: async () => {
                try {
                    await writable.abort()
                } catch (error) {
                    throw named(error)
                }
                await removeVideoPick(pick)
            },
        },
        signal,
    )
    if (signal?.aborted) {
        await output.abort()
        throw cancelled()
    }
    return output
}

/** Safari cannot send a file handle to a worker, so the worker finds the staged file by name. */
export const openStagedFile = async (
    name: string,
    signal?: AbortSignal,
): Promise<PositionTarget> => {
    let handle: FileSystemFileHandle
    try {
        const root = await navigator.storage.getDirectory()
        const directory = await root.getDirectoryHandle('export-video')
        handle = await directory.getFileHandle(name)
    } catch (error) {
        throw fileErrorOf(error)
    }
    return openStagedTarget(handle, signal)
}

/** The owner deletes the staged file through videoOutput.remove after this handle closes. */
export const openStagedTarget = async (
    handle: FileSystemFileHandle,
    signal?: AbortSignal,
): Promise<PositionTarget> => {
    signal?.throwIfAborted()
    let access: SyncAccess
    try {
        access = await (
            handle as FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncAccess> }
        ).createSyncAccessHandle()
    } catch (error) {
        throw fileErrorOf(error)
    }
    let size = 0
    const output = target(
        {
            write: (data, position) => {
                try {
                    for (let offset = 0; offset < data.length;) {
                        const written = access.write(data.subarray(offset), {
                            at: position + offset,
                        })
                        if (written <= 0 || written > data.length - offset)
                            throw new FileError('io', 'Video write made no progress')
                        offset += written
                    }
                    size = Math.max(size, position + data.length)
                    return Promise.resolve()
                } catch (error) {
                    return Promise.reject(fileErrorOf(error))
                }
            },
            close: (commit) => {
                signal?.throwIfAborted()
                commit()
                access.truncate(size)
                access.flush()
                access.close()
                return Promise.resolve()
            },
            abort: () => {
                access.close()
                return Promise.resolve()
            },
        },
        signal,
    )
    if (signal?.aborted) {
        await output.abort()
        throw cancelled()
    }
    return output
}
