import assert from 'node:assert/strict'
import test from 'node:test'
import {
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
    estimatedBytes: 10e6,
    pickOptions: {
        name: 'video.mp4',
        type: { description: 'MP4', extension: '.mp4' },
        ui: {
            preparing: () => {
                throw new Error('Unexpected UI')
            },
            emptied: async () => undefined,
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

test('only unavailable staging selects memory and the estimate limits that route', async () => {
    const manager = new FakeLockManager()
    const output = createVideoOutput(memoryVideoStore(), manager.client(manager.scheduler.main), {
        deliver: async () => 'delivered',
        canShare: () => false,
    })
    for (const name of ['SecurityError', 'NotSupportedError', 'QuotaExceededError']) {
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
                limit: 150000000,
            })
            assert.deepEqual(
                await prepareVideoDestination({
                    ...options(),
                    platform,
                    estimatedBytes: 100000001,
                }),
                { kind: 'unavailable', reason: 'memoryLimit' },
            )
        }
    }
    assert.deepEqual(await prepareVideoDestination(options()), {
        kind: 'unavailable',
        reason: 'output',
    })
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
