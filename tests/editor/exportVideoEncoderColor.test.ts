import assert from 'node:assert/strict'
import test from 'node:test'
import {
    chooseColor,
    colorCandidates,
    measureEncoderColor,
    STRIPES,
} from '../../src/exportVideo/worker/encoderColor'

test('a candidate is measured only when it is close and no other candidate comes close', () => {
    // Measured in Firefox (converts with BT.601 limited, reports BT.709 limited) and in Chromium
    // (converts as it reports). Agreement with the report is still a measurement.
    assert.deepEqual(chooseColor([12.94, 6.89, 11.44, 0.78]), colorCandidates[3])
    assert.deepEqual(chooseColor([0.06, 10.44, 5.89, 11.67]), colorCandidates[0])
    for (const [i, candidate] of colorCandidates.entries())
        assert.deepEqual(chooseColor(colorCandidates.map((_, j) => (i === j ? 0.5 : 8))), candidate)
    // A tie or near tie, too much error, or missing distances.
    assert.equal(chooseColor([1, 1, 8, 9]), undefined)
    assert.equal(chooseColor([1.5, 3, 8, 9]), undefined)
    assert.equal(chooseColor([4, 7, 8, 9]), undefined)
    assert.equal(chooseColor([NaN, 7, 8, 9]), undefined)
})

const WIDTH = 96
/** Decoded RGB levels for each stripe of a candidate's frame, far apart between candidates. */
const levels = (candidate: number) =>
    STRIPES.map((_, stripe) => [0, 1, 2].map((c) => 40 + 30 * stripe + 12 * candidate + c))

type World = {
    truth: number
    reverse?: boolean
    mixedSpaces?: boolean
    decoderError?: boolean
    unsupported?: boolean
    stall?: 'encoder' | 'decoder'
    capturedTimestamp?: number
}

/** WebCodecs and canvas fakes: a frame decodes to the levels of the candidate it was made as. */
const withFakes = async <T>(world: World, run: (codecs: { state: string }[]) => Promise<T>) => {
    const codecs: { state: string }[] = []
    class FakeFrame {
        constructor(
            readonly levels: number[][],
            readonly timestamp: number,
        ) {}
        close() {}
    }
    class FakeVideoFrame extends FakeFrame {
        constructor(_data: unknown, init: { timestamp: number }) {
            super(levels(Math.round((init.timestamp * 30) / 1e6) - 1), init.timestamp)
        }
    }
    const never = () => new Promise<void>(() => undefined)
    class FakeEncoder {
        state = 'unconfigured'
        pending: FakeFrame[] = []
        sent = false
        constructor(
            readonly init: {
                output: (chunk: unknown, metadata?: EncodedVideoChunkMetadata) => void
            },
        ) {
            codecs.push(this)
        }
        configure() {
            this.state = 'configured'
        }
        encode(frame: FakeFrame) {
            this.pending.push(new FakeFrame(frame.levels, frame.timestamp))
        }
        flush() {
            if (world.stall === 'encoder') return never()
            return Promise.resolve().then(() => {
                for (const frame of this.pending.splice(0)) {
                    const metadata = this.sent
                        ? undefined
                        : { decoderConfig: { codec: 'vp09.00.10.08' } }
                    this.sent = true
                    this.init.output(frame, metadata)
                }
            })
        }
        close() {
            this.state = 'closed'
        }
    }
    class FakeDecoder {
        static isConfigSupported = () => Promise.resolve({ supported: !world.unsupported })
        state = 'unconfigured'
        pending: FakeFrame[] = []
        constructor(
            readonly init: { output: (frame: unknown) => void; error: (error: Error) => void },
        ) {
            codecs.push(this)
        }
        configure() {
            this.state = 'configured'
        }
        decode(chunk: FakeFrame) {
            this.pending.push(chunk)
        }
        async flush() {
            if (world.stall === 'decoder') return never()
            await Promise.resolve()
            if (world.decoderError) {
                this.init.error(new Error('Decoding failed'))
                throw new Error('Decoding failed')
            }
            const frames = this.pending.splice(0)
            if (world.reverse) frames.reverse()
            for (const [i, frame] of frames.entries())
                this.init.output({
                    ...frame,
                    colorSpace: {
                        toJSON: () => ({ matrix: world.mixedSpaces && i === 2 ? 'rgb' : 'bt709' }),
                    },
                    close() {},
                })
        }
        close() {
            this.state = 'closed'
        }
    }
    class FakeCanvas {
        getContext() {
            let current = [0, 0, 0]
            return {
                drawImage(frame: FakeFrame, x: number) {
                    current = frame.levels[Math.floor(((x + 4) * STRIPES.length) / WIDTH)]!
                },
                getImageData: () => ({
                    data: Uint8ClampedArray.from({ length: 256 }, (_, k) => current[k % 4] ?? 255),
                }),
            }
        }
    }
    const globals = globalThis as Record<string, unknown>
    const fakes = {
        VideoEncoder: FakeEncoder,
        VideoDecoder: FakeDecoder,
        VideoFrame: FakeVideoFrame,
        OffscreenCanvas: FakeCanvas,
    }
    const saved = Object.fromEntries(Object.keys(fakes).map((key) => [key, globals[key]]))
    Object.assign(globals, fakes)
    try {
        return await run(codecs)
    } finally {
        Object.assign(globals, saved)
    }
}

const measure = (world: World, signal?: AbortSignal) =>
    measureEncoderColor(
        { codec: 'vp09.00.10.08', width: WIDTH, height: 16 },
        30,
        () => {
            // The captured stripes decode one level off the true candidate's.
            const captured = levels(world.truth).map((rgb) => [rgb[0]! + 1, rgb[1]!, rgb[2]!])
            const frame = { levels: captured, timestamp: world.capturedTimestamp ?? 0 }
            return { ...frame, close() {} } as unknown as VideoFrame
        },
        signal,
    )

test('decoded calibration frames are matched to their inputs by timestamp', async () => {
    for (const reverse of [false, true])
        await withFakes({ truth: 1, reverse }, async (codecs) => {
            assert.deepEqual(await measure({ truth: 1, reverse }), colorCandidates[1])
            assert.deepEqual(
                codecs.map((codec) => codec.state),
                ['closed', 'closed'],
            )
        })
})

test('a measurement that cannot be trusted or completed is not a measurement', async () => {
    for (const world of [
        { truth: 1, mixedSpaces: true },
        { truth: 1, decoderError: true },
        { truth: 1, unsupported: true },
        { truth: 1, capturedTimestamp: 33333 },
    ])
        await withFakes(world, async (codecs) => {
            assert.equal(await measure(world), undefined)
            assert.ok(codecs.every((codec) => codec.state === 'closed'))
        })
})

test('cancel ends a calibration whose flush never resolves and closes its codecs', async () => {
    for (const stall of ['encoder', 'decoder'] as const)
        await withFakes({ truth: 0, stall }, async (codecs) => {
            const controller = new AbortController()
            const result = measure({ truth: 0, stall }, controller.signal)
            await new Promise((resolve) => setImmediate(resolve))
            assert.equal(codecs.length, stall === 'encoder' ? 1 : 2)
            controller.abort()
            assert.equal(await result, undefined)
            assert.ok(codecs.every((codec) => codec.state === 'closed'))
        })
    await withFakes({ truth: 0 }, async (codecs) => {
        assert.equal(await measure({ truth: 0 }, AbortSignal.abort()), undefined)
        assert.ok(codecs.every((codec) => codec.state === 'closed'))
    })
})
