import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
    failureDetails,
    restoreExportError,
    serializeExportError,
} from '../../src/exportVideo/error'
import {
    openPickedTarget,
    openStagedFile,
    openStagedTarget,
} from '../../src/exportVideo/worker/target'
import { isWriteRefusal } from '../../src/platform/handover'
import { memoryVideoStore } from '../../src/platform/mockVideoOutput'
import { FileError } from '../../src/platform/types'

const deferred = () => {
    let resolve!: () => void
    return {
        promise: new Promise<void>((done) => {
            resolve = done
        }),
        resolve: () => resolve(),
    }
}

for (const operation of ['open', 'abort'] as const)
    test(`a staged ${operation} failure retains its FileError code across the worker`, async () => {
        const handle = {
            createSyncAccessHandle: () => {
                if (operation === 'open') throw new DOMException('Full', 'QuotaExceededError')
                return Promise.resolve({
                    close: () => {
                        throw new DOMException('Denied', 'NotAllowedError')
                    },
                })
            },
        } as unknown as FileSystemFileHandle
        await assert.rejects(
            async () => {
                try {
                    const target = await openStagedTarget(handle)
                    await target.abort()
                } catch (error) {
                    throw restoreExportError(structuredClone(serializeExportError(error)))
                }
            },
            { code: operation === 'open' ? 'no-space' : 'denied' },
        )
    })

/** Models a picked file and a separate swap, with gates around the final read and close. */
const pickedFile = (...faults: ('write' | 'close' | 'remove' | 'open')[]) => {
    /** getFile() refused, as on a platform that refuses to read the picked file. */
    let refused = false
    let file: File | undefined = new File([], 'clip.mp4', { lastModified: 42 })
    let swap = new Uint8Array()
    let removed = 0
    let aborted = 0
    let readGate: ReturnType<typeof deferred> | undefined
    let closeGate: ReturnType<typeof deferred> | undefined
    const reading = deferred()
    const closing = deferred()
    const handle = {
        name: 'clip.mp4',
        getFile: async () => {
            reading.resolve()
            await readGate?.promise
            if (refused) throw new DOMException('Not allowed', 'NotAllowedError')
            if (!file) throw new DOMException('Gone', 'NotFoundError')
            return file
        },
        remove: () => {
            removed++
            if (faults.includes('remove')) throw new DOMException('Denied', 'NotAllowedError')
            file = undefined
            return Promise.resolve()
        },
        createWritable: async () => {
            if (faults.includes('open')) throw new DOMException('Not allowed', 'NotAllowedError')
            return {
                write: ({ position, data }: { position: number; data: Uint8Array }) => {
                    if (faults.includes('write'))
                        throw new DOMException('Full', 'QuotaExceededError')
                    const next = new Uint8Array(Math.max(swap.length, position + data.length))
                    next.set(swap)
                    next.set(data, position)
                    swap = next
                    return Promise.resolve()
                },
                close: async () => {
                    closing.resolve()
                    await closeGate?.promise
                    if (faults.includes('close'))
                        throw new DOMException('Full', 'QuotaExceededError')
                    file = new File([swap], 'clip.mp4', { lastModified: 43 })
                },
                abort: () => {
                    aborted++
                    swap = new Uint8Array()
                    return Promise.resolve()
                },
            }
        },
    } as unknown as FileSystemFileHandle
    return {
        pick: { handle, lastModified: 42 },
        get file() {
            return file
        },
        get removed() {
            return removed
        },
        get aborted() {
            return aborted
        },
        change: (text: string) => {
            file = new File([text], 'clip.mp4', { lastModified: 43 })
        },
        refuseReads: () => {
            refused = true
        },
        holdRead: () => {
            readGate = deferred()
            return { ...readGate, reached: reading.promise }
        },
        holdClose: () => {
            closeGate = deferred()
            return { ...closeGate, reached: closing.promise }
        },
    }
}

test('picked and staged targets apply writes at positions, including header rewrites', async () => {
    const picked = pickedFile()
    const store = memoryVideoStore()
    const handle = await store.create('clip.webm')
    for (const output of [await openPickedTarget(picked.pick), await openStagedTarget(handle)]) {
        await output.write(new Uint8Array([1, 2, 3, 4]), 0)
        await output.write(new Uint8Array([8, 9]), 1)
        await output.close()
        await output.abort()
    }
    assert.deepEqual([...new Uint8Array(await picked.file!.arrayBuffer())], [1, 8, 9, 4])
    assert.deepEqual(
        [...new Uint8Array(await (await store.file('clip.webm')).arrayBuffer())],
        [1, 8, 9, 4],
    )
    assert.equal(picked.removed, 0)
})

for (const text of ['another writer', ''])
    test(`commit refuses a changed ${text ? 'filled' : 'empty'} file and never removes it`, async () => {
        const f = pickedFile()
        const output = await openPickedTarget(f.pick)
        await output.write(new Uint8Array([1, 2]), 0)
        f.change(text)
        await assert.rejects(output.close(), { code: 'conflict' })
        assert.equal(await f.file!.text(), text)
        assert.equal(f.aborted, 1)
        assert.equal(f.removed, 0)
    })

test('cancelling during the final read aborts the swap and removes the unchanged empty pick', async () => {
    const f = pickedFile()
    const output = await openPickedTarget(f.pick)
    await output.write(new Uint8Array([1]), 0)
    const read = f.holdRead()
    const close = output.close()
    const rejected = assert.rejects(close, { name: 'AbortError' })
    await read.reached
    const abort = output.abort()
    read.resolve()
    await rejected
    await abort
    assert.equal(f.aborted, 1)
    assert.equal(f.removed, 1)
})

test('cancelling after close starts does not remove the committed file', async () => {
    const f = pickedFile()
    const controller = new AbortController()
    const output = await openPickedTarget(f.pick, controller.signal)
    await output.write(new Uint8Array([7]), 0)
    const closing = f.holdClose()
    const close = output.close()
    await closing.reached
    controller.abort()
    closing.resolve()
    await close
    await output.abort()
    assert.equal(f.file!.size, 1)
    assert.equal(f.removed, 0)
})

test('an already cancelled job removes its accepted empty pick without writing', async () => {
    const f = pickedFile()
    await assert.rejects(openPickedTarget(f.pick, AbortSignal.abort()), { name: 'AbortError' })
    assert.equal(f.removed, 1)
})

for (const fault of ['write', 'close'] as const)
    test(`a quota failure during ${fault} aborts the picked swap and removes the empty file`, async () => {
        const f = pickedFile(fault)
        const output = await openPickedTarget(f.pick)
        await assert.rejects(
            async () => {
                await output.write(new Uint8Array([1, 2]), 0)
                await output.close()
            },
            { code: 'no-space', fileName: 'clip.mp4' },
        )
        assert.equal(f.aborted, 1)
        assert.equal(f.removed, 1)
        assert.equal(f.file, undefined)
    })

test('a failed removal names the empty file and stays visible after signal cancellation', async () => {
    const f = pickedFile('remove')
    const controller = new AbortController()
    const output = await openPickedTarget(f.pick, controller.signal)
    controller.abort()
    await assert.rejects(output.abort(), { code: 'denied', fileName: 'clip.mp4' })
    await assert.rejects(output.close(), { code: 'denied', fileName: 'clip.mp4' })
    assert.equal(f.file!.size, 0)
})

test('a failed write or open keeps its error when removing the empty pick is refused, which Error Details add', async () => {
    const written = pickedFile('write', 'remove')
    const output = await openPickedTarget(written.pick)
    const write = await output.write(new Uint8Array([1]), 0).catch((error: unknown) => error)
    // A full disk stays a full disk: no refused write, which would export again.
    assert.ok(write instanceof FileError && write.code === 'no-space' && !isWriteRefusal(write))
    const restored = restoreExportError(structuredClone(serializeExportError(write)))
    assert.deepEqual(failureDetails(restored), ['FileError: clip.mp4 was left empty'])
    assert.equal(written.file!.size, 0)
    const opened = pickedFile('open', 'remove')
    await assert.rejects(openPickedTarget(opened.pick), (error: unknown) => {
        assert.ok(error instanceof FileError && error.message === 'Not allowed')
        assert.deepEqual(failureDetails(error), ['FileError: clip.mp4 was left empty'])
        return true
    })
})

test('a staged write handles partial writes and releases its access handle after a quota error', async () => {
    let closed = 0
    const positions: number[] = []
    const handle = {
        createSyncAccessHandle: () =>
            Promise.resolve({
                write: (_data: Uint8Array, { at }: { at: number }) => {
                    positions.push(at)
                    if (at >= 2) throw new DOMException('Full', 'QuotaExceededError')
                    return 2
                },
                close: () => {
                    closed++
                },
            }),
    } as unknown as FileSystemFileHandle
    const output = await openStagedTarget(handle)
    await assert.rejects(output.write(new Uint8Array([1, 2, 3, 4]), 0), { code: 'no-space' })
    await output.abort()
    assert.deepEqual(positions, [0, 2])
    assert.equal(closed, 1)
})

test('a staged file opens from its name in the export-video directory', async () => {
    const opened: string[] = []
    const handle = {
        createSyncAccessHandle: () =>
            Promise.resolve({
                write: (data: Uint8Array) => data.length,
                truncate: () => undefined,
                flush: () => undefined,
                close: () => undefined,
            }),
    }
    const root = {
        getDirectoryHandle: (name: string) => {
            opened.push(name)
            return Promise.resolve({
                getFileHandle: (file: string) => {
                    opened.push(file)
                    if (file !== 'a1.mp4') throw new DOMException('Missing', 'NotFoundError')
                    return Promise.resolve(handle)
                },
            })
        },
    }
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { storage: { getDirectory: () => Promise.resolve(root) } },
    })
    try {
        const output = await openStagedFile('a1.mp4')
        await output.write(new Uint8Array([1]), 0)
        await output.close()
        assert.deepEqual(opened, ['export-video', 'a1.mp4'])
        await assert.rejects(openStagedFile('b2.mp4'), { code: 'not-found' })
    } finally {
        if (saved) Object.defineProperty(globalThis, 'navigator', saved)
        else Reflect.deleteProperty(globalThis, 'navigator')
    }
})

test('a picked file the platform refuses to read is committed, never checked as changed', async () => {
    const f = pickedFile()
    const output = await openPickedTarget({ handle: f.pick.handle })
    await output.write(new Uint8Array([5, 6]), 0)
    f.refuseReads()
    await output.close()
    assert.deepEqual([...new Uint8Array(await f.file!.arrayBuffer())], [5, 6])
})

for (const unreadable of ['refused', 'no time'] as const)
    test(`cleanup leaves a picked file it cannot establish as unchanged: ${unreadable}`, async () => {
        const f = pickedFile('open')
        if (unreadable === 'refused') f.refuseReads()
        // The refusal to write is reported, never the refused read of the cleanup after it.
        await assert.rejects(
            openPickedTarget(unreadable === 'refused' ? f.pick : { handle: f.pick.handle }),
            { code: 'denied', step: undefined, fileName: 'clip.mp4' },
        )
        assert.equal(f.removed, 0)
        assert.equal(f.file!.size, 0)
    })
