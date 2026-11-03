import assert from 'node:assert/strict'
import test from 'node:test'
import './saveMatrix/env'

const { createExportJob } = await import('../../src/exportVideo/job')
const { failureDetails, serializeExportError } = await import('../../src/exportVideo/error')
const { createState } = await import('../../src/state')
const { FileError } = await import('../../src/platform/types')
type Job = ReturnType<typeof createExportJob>
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

/** Runs a job whose picked file the worker refuses to write; `then` shapes the rerun. */
const refusedThenRerun = async (then: {
    prepare?: FromWorker
    reply?: FromWorker
    fallback?: (signal: AbortSignal, job: Job) => Promise<JobDestination>
    file?: () => Promise<File>
}) => {
    const starts: ToWorker[] = []
    const discarded: string[] = []
    const destination = (kind: 'picked' | 'memory'): JobDestination => ({
        worker:
            kind === 'picked' ? { kind, pick: { handle: {} as FileSystemFileHandle } } : { kind },
        ready: {
            file: then.file ?? (async () => new File([], 'clip.webm')),
            deliver: async () => 'delivered',
            end: async () => undefined,
        },
        discard: async () => void discarded.push(kind),
    })
    let workers = 0
    const job: Job = createExportJob({
        ...jobOptions(),
        destination: async () => destination('picked'),
        fallback: (signal) =>
            then.fallback ? then.fallback(signal, job) : Promise.resolve(destination('memory')),
        worker: () =>
            fakeWorker(
                workers++ ? (then.prepare ?? { type: 'prepared' }) : { type: 'prepared' },
                (to) => {
                    starts.push(to)
                    return starts.length === 1 ? failed(refusal()) : then.reply
                },
            ),
    })
    const state = await job.start()
    return { job, state, starts, discarded }
}

const detailsOf = (state: Awaited<ReturnType<Job['start']>>) => {
    assert.equal(state.phase, 'failed')
    return state.phase === 'failed' ? failureDetails(state.error) : []
}

test('a rerun that fails to prepare, to get its destination or to read its file keeps the refusal in Error Details', async () => {
    const reasons = [
        { prepare: failed(new Error('Graphics failed')) },
        { fallback: () => Promise.reject(new FileError('no-space', 'Storage is full')) },
        {
            reply: { type: 'done', result: {}, warnings: [] } satisfies FromWorker,
            file: () => Promise.reject(new FileError('io', 'Unreadable')),
        },
    ]
    for (const reason of reasons) {
        const { state } = await refusedThenRerun(reason)
        assert.deepEqual(detailsOf(state), ['FileError: Write refused'])
    }
})

test('a refused rerun ends the export: no third encode', async () => {
    const { state, starts } = await refusedThenRerun({ reply: failed(refusal()) })
    assert.equal(starts.length, 2)
    assert.equal(state.phase === 'failed' && (state.error as Error).message, 'Write refused')
    assert.deepEqual(detailsOf(state), ['FileError: Write refused'])
})

test('Cancel while the rerun waits for its destination starts no second encode and discards the late destination', async () => {
    let late!: (destination: JobDestination) => void
    let discardedLate = false
    const { state, starts, discarded } = await refusedThenRerun({
        fallback: (_, job) => {
            job.cancel()
            return new Promise((resolve) => (late = resolve))
        },
    })
    assert.equal(state.phase, 'cancelled')
    assert.equal(starts.length, 1)
    assert.deepEqual(discarded, ['picked'])
    late({
        worker: { kind: 'memory' },
        discard: async () => void (discardedLate = true),
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(discardedLate, true)
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
