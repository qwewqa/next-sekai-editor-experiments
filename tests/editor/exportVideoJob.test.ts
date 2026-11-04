import assert from 'node:assert/strict'
import test from 'node:test'
import './saveMatrix/env'

const { createExportJob } = await import('../../src/exportVideo/job')
const { serializeExportError } = await import('../../src/exportVideo/error')
const { createState } = await import('../../src/state')
const { FileError } = await import('../../src/platform/types')
type Options = Parameters<typeof createExportJob>[0]
type JobDestination = Awaited<ReturnType<Options['destination']>>
type FromWorker = import('../../src/exportVideo/protocol').FromExportWorker
type ToWorker = import('../../src/exportVideo/protocol').ToExportWorker

// No other lock holder: each request is granted at once.
Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
        request: (_: string, options: { signal?: AbortSignal }, run: () => Promise<unknown>) => {
            options.signal?.throwIfAborted()
            return run()
        },
    },
})

const refusal = () => new FileError('denied', 'Write refused')
const failed = (error: Error): FromWorker => ({
    type: 'failed',
    error: serializeExportError(error),
})

/** A worker that prepares, then answers its `start` with `reply`, or holds it when undefined. */
const fakeWorker = (prepare: FromWorker, reply?: (to: ToWorker) => FromWorker | undefined) => {
    const worker = {
        onmessage: undefined as ((event: { data: FromWorker }) => void) | undefined,
        postMessage(message: ToWorker) {
            const answer =
                message.type === 'prepare' ? prepare : message.type === 'start' && reply?.(message)
            if (answer) setImmediate(() => worker.onmessage?.({ data: answer }))
        },
        terminate() {},
    }
    return worker as unknown as Worker
}

/** A three-frame job on an empty chart, with sound off and no destination or worker yet. */
const jobOptions = () =>
    ({
        snapshot: createState(
            {
                initialLife: 1000,
                isDynamicStages: false,
                bpms: [{ beat: 0, bpm: 120 }],
                groups: new Map(),
                stages: new Map(),
                cameraEvents: [],
                stageMaskEvents: [],
                stagePivotEvents: [],
                stageStyleEvents: [],
                stageTransformEvents: [],
                timeScales: [],
                slides: [],
            },
            0,
        ),
        settings: {
            format: 'webm',
            width: 320,
            height: 180,
            frameRate: 30,
            videoBitrate: 1e6,
            audioBitrate: 128000,
            bgm: false,
            sfx: false,
            in: 0,
            frames: 3,
            bgmVolume: 100,
            sfxVolume: 100,
            fadeIn: 0,
            fadeOut: 0,
            renderScale: 1,
            antialias: false,
            noteSpeed: 6,
            showEffects: true,
            showCombo: true,
            backdrop: [0, 0, 0],
        },
        buffers: { sfx: {} },
        platform: { onCloseRequested: () => () => undefined },
        services: {
            probes: {
                resolve: async () => ({
                    supported: true,
                    format: 'webm',
                    video: { codec: 'vp09.00.10.08', width: 320, height: 180 },
                }),
            },
        },
        assets: async () => ({ skin: { texture: { close() {} } } }) as never,
        changed: () => undefined,
    }) satisfies Partial<Options>

const staged = (): JobDestination => ({
    worker: { kind: 'staged', name: 'clip.webm' },
    ready: {
        file: async () => new File([], 'clip.webm'),
        deliver: async () => 'delivered',
        end: async () => undefined,
    },
    discard: async () => undefined,
})

test('a picked file the platform refuses to write ends the export: one encode, the pick discarded', async () => {
    const starts: ToWorker[] = []
    const discarded: string[] = []
    const job = createExportJob({
        ...jobOptions(),
        destination: async () => ({
            worker: { kind: 'picked', pick: { handle: {} as FileSystemFileHandle } },
            discard: async () => void discarded.push('picked'),
        }),
        worker: () =>
            fakeWorker({ type: 'prepared' }, (to) => {
                starts.push(to)
                return failed(refusal())
            }),
    })
    const state = await job.start()
    assert.equal(state.phase, 'failed')
    const error = state.phase === 'failed' ? state.error : undefined
    assert.ok(error instanceof FileError && error.code === 'denied')
    assert.equal(starts.length, 1)
    assert.deepEqual(discarded, ['picked'])
})

test('the warnings of a finished export stay with Ready and Done', async () => {
    const warnings = [{ code: 'framesMissing', count: 2 } as const]
    const job = createExportJob({
        ...jobOptions(),
        destination: async () => staged(),
        worker: () =>
            fakeWorker({ type: 'prepared' }, () => ({ type: 'done', result: {}, warnings })),
    })
    const ready = await job.start()
    assert.equal(ready.phase, 'ready')
    assert.deepEqual(ready.phase === 'ready' && ready.warnings, warnings)
    await job.deliver('download')
    assert.deepEqual(job.state.phase === 'ready' && job.state.warnings, warnings)
    await job.endReady()
    assert.deepEqual(job.state.phase === 'done' && job.state.warnings, warnings)
})

test('mixing that fails ends the export with the sound failure', async () => {
    const { AudioFailure } = await import('../../src/exportVideo/error')
    const mixing = new Error('Mixing failed')
    Object.defineProperty(globalThis, 'OfflineAudioContext', {
        configurable: true,
        value: function () {
            throw mixing
        },
    })
    try {
        const job = createExportJob({
            ...jobOptions(),
            settings: { ...jobOptions().settings, sfx: true },
            destination: async () => staged(),
            worker: () => {
                const made = {
                    onmessage: undefined as ((event: { data: FromWorker }) => void) | undefined,
                    postMessage(message: ToWorker) {
                        const answer: FromWorker | undefined =
                            message.type === 'prepare'
                                ? { type: 'prepared' }
                                : message.type === 'start'
                                  ? { type: 'block' }
                                  : message.type === 'cancel'
                                    ? { type: 'cancelled' }
                                    : undefined
                        if (answer) setImmediate(() => made.onmessage?.({ data: answer }))
                    },
                    terminate() {},
                }
                return made as unknown as Worker
            },
        })
        const state = await job.start()
        assert.equal(state.phase, 'failed')
        assert.ok(state.phase === 'failed' && state.error instanceof AudioFailure)
        assert.equal(state.error.cause, mixing)
    } finally {
        Reflect.deleteProperty(globalThis, 'OfflineAudioContext')
    }
})

test('a failed preparation is tried again by the export', async () => {
    let workers = 0
    const job = createExportJob({
        ...jobOptions(),
        destination: async () => staged(),
        worker: () =>
            fakeWorker(
                workers++ ? { type: 'prepared' } : failed(new Error('Graphics failed')),
                () => ({ type: 'done', result: {}, warnings: [] }),
            ),
    })
    await assert.rejects(job.preview(0), /Graphics failed/)
    const state = await job.start()
    assert.equal(state.phase, 'ready', state.phase === 'failed' ? String(state.error) : '')
    assert.equal(workers, 2)
})
