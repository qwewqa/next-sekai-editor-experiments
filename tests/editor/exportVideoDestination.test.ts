import assert from 'node:assert/strict'
import test from 'node:test'
import {
    memoryRouteTaken,
    pickedDestination,
    prepareVideoDestination,
} from '../../src/editor/exportVideo/destination'
import {
    videoReport,
    videoSpeed,
    type VideoReportSettings,
} from '../../src/editor/exportVideo/report'
import { FakeLockManager } from '../../src/local/testing/locks'
import { memoryVideoStore } from '../../src/platform/mockVideoOutput'
import { createVideoOutput } from '../../src/platform/videoOutput'

const options = (): Parameters<typeof prepareVideoDestination>[0] => ({
    platform: {},
    pick: async () => ({ kind: 'cancelled' }),
    id: 'video',
    format: 'mp4',
    pickOptions: {
        name: 'video.mp4',
        type: { description: 'MP4', extension: '.mp4' },
        ui: {
            preparing: () => {
                throw new Error('Unexpected UI')
            },
        },
    },
})

test('destination preserves picker dismissal and a dotted extension', async () => {
    const cancelled = { kind: 'dismissed' } as const
    const result = await prepareVideoDestination({
        ...options(),
        format: 'webm',
        platform: { pickSaveFile: async () => undefined },
        pick: async (pick) => {
            assert.equal(pick.type.extension, '.webm')
            return cancelled
        },
    })
    assert.equal(result, cancelled)
})

test('staged allocation retains ownership and deletes a cancelled allocation', async () => {
    const store = memoryVideoStore()
    const manager = new FakeLockManager()
    const output = createVideoOutput(store, manager.client(manager.scheduler.main), {
        deliver: async () => 'delivered',
        canShare: () => false,
    })
    const result = await prepareVideoDestination({
        ...options(),
        platform: { videoOutput: output },
    })
    assert.equal(result.kind, 'staged')
    assert.deepEqual(await store.names(), ['video.mp4'])
    if (result.kind === 'staged') await result.stage.endReady()
    assert.deepEqual(await store.names(), [])
    const controller = new AbortController()
    const cancelled = {
        ...output,
        stage: async (id: string, format: 'mp4' | 'webm') => {
            const stage = await output.stage(id, format)
            controller.abort()
            return stage
        },
    }
    await assert.rejects(
        prepareVideoDestination({
            ...options(),
            platform: { videoOutput: cancelled },
            pickOptions: { ...options().pickOptions, signal: controller.signal },
        }),
        { name: 'AbortError' },
    )
    assert.deepEqual(await store.names(), [])
})

test('an export to memory is remembered for the page', async () => {
    const manager = new FakeLockManager()
    const output = createVideoOutput(memoryVideoStore(), manager.client(manager.scheduler.main), {
        deliver: async () => 'delivered',
        canShare: () => false,
    })
    assert.equal(memoryRouteTaken(), false)
    await prepareVideoDestination({
        ...options(),
        platform: { videoOutput: output },
        syncAccess: false,
    })
    assert.equal(memoryRouteTaken(), true)
})

test('the route check finds the memory route from the origin private file system', async () => {
    const { readMemoryRoute } = await import('../../src/exportVideo/route')
    const globals = globalThis as Record<string, unknown>
    const saved = { navigator: globals.navigator, handle: globals.FileSystemFileHandle }
    const world = (getDirectory: () => Promise<unknown>, sync: boolean) => {
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: { storage: { getDirectory } },
        })
        globals.FileSystemFileHandle = class {}
        if (sync)
            Object.assign((globals.FileSystemFileHandle as { prototype: object }).prototype, {
                createSyncAccessHandle() {},
            })
    }
    const refused = (name: string) => () => Promise.reject(new DOMException('Refused', name))
    try {
        world(async () => ({}), true)
        assert.equal(await readMemoryRoute(), false)
        world(async () => ({}), false)
        assert.equal(await readMemoryRoute(), true)
        // Firefox private windows and Safari Private Browsing.
        for (const name of ['SecurityError', 'UnknownError']) {
            world(refused(name), true)
            assert.equal(await readMemoryRoute(), true)
        }
        world(refused('QuotaExceededError'), true)
        assert.equal(await readMemoryRoute(), undefined)
    } finally {
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: saved.navigator,
        })
        globals.FileSystemFileHandle = saved.handle
    }
})

test('only unavailable staging selects memory, whatever the size', async () => {
    const manager = new FakeLockManager()
    const output = createVideoOutput(memoryVideoStore(), manager.client(manager.scheduler.main), {
        deliver: async () => 'delivered',
        canShare: () => false,
    })
    for (const name of [
        'SecurityError',
        'NotSupportedError',
        'UnknownError',
        'QuotaExceededError',
    ]) {
        const platform = {
            videoOutput: {
                ...output,
                stage: async () => {
                    throw new DOMException('Unavailable', name)
                },
            },
        }
        if (name === 'QuotaExceededError')
            await assert.rejects(prepareVideoDestination({ ...options(), platform }), {
                code: 'no-space',
            })
        else {
            assert.deepEqual(await prepareVideoDestination({ ...options(), platform }), {
                kind: 'memory',
            })
        }
    }
    assert.deepEqual(await prepareVideoDestination(options()), {
        kind: 'unavailable',
        reason: 'output',
    })
})

test('a worker that cannot write a staged file selects the memory route without staging', async () => {
    const manager = new FakeLockManager()
    const store = memoryVideoStore()
    const output = createVideoOutput(store, manager.client(manager.scheduler.main), {
        deliver: async () => 'delivered',
        canShare: () => false,
    })
    const platform = { videoOutput: output }
    assert.deepEqual(await prepareVideoDestination({ ...options(), platform, syncAccess: false }), {
        kind: 'memory',
    })
    assert.deepEqual(await store.names(), [])
})

test('report payload keeps explicit work time and excludes raw names, errors and failed size', () => {
    const settings: VideoReportSettings = {
        format: 'mp4',
        support: 'full',
        resolution: 1080,
        frameRate: 60,
        aspect: '16:9',
        quality: 'standard',
        renderScale: 1,
        antialias: true,
        audio: 'both',
        range: 'whole',
        source: 'live',
    }
    const end = {
        outcome: 'done' as const,
        target: 'download' as const,
        hidden: true,
        lengthSeconds: 10,
        sizeBytes: 12e6,
        tookMs: 5000,
        renderingMs: 4000,
        filename: 'private.mp4',
    }
    const report = videoReport(settings, end)
    assert.equal(report.took, 5000)
    assert.equal(report.length, 10000)
    assert.equal(report.speed, '2-4')
    assert.equal('filename' in report, false)
    const failed = videoReport(settings, {
        ...end,
        outcome: 'failed',
        stage: 'render',
        reason: 'encoder',
    })
    assert.equal(failed.size, undefined)
    assert.equal(failed.reason, 'encoder')
    assert.equal(videoSpeed(10, undefined), undefined)
    assert.equal(videoSpeed(10, 0), undefined)
})

test('a picked destination discards the emptied file, and never a changed one', async () => {
    const pickedFile = (size: number, lastModified: number) => {
        let file: File | undefined = new File([new Uint8Array(size)], 'clip.mp4', { lastModified })
        const handle = {
            name: 'clip.mp4',
            getFile: () =>
                file
                    ? Promise.resolve(file)
                    : Promise.reject(new DOMException('', 'NotFoundError')),
            remove: () => {
                file = undefined
                return Promise.resolve()
            },
        } as unknown as FileSystemFileHandle
        return { handle, exists: () => file !== undefined }
    }
    // Cancelled after picking: the worker never opened the empty file.
    const emptied = pickedFile(0, 42)
    await pickedDestination({ handle: emptied.handle, lastModified: 42 }).discard()
    assert.equal(emptied.exists(), false)
    const changed = pickedFile(5, 43)
    await pickedDestination({ handle: changed.handle, lastModified: 42 }).discard()
    assert.equal(changed.exists(), true)
})
