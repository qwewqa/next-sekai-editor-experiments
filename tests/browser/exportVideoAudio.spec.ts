import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
    await page.route('**/__export-audio-test', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }),
    )
    await page.goto('/__export-audio-test')
})

test('a short clip matches Play sample for sample at a nonzero In', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { mixAudio } = await import('/src/exportVideo/mix.ts')
        const { createSoundScheduler } = await import('/src/playerSoundScheduler.ts')
        const { exportSoundState, exportSoundSource } =
            await import('/tests/helpers/exportVideo.ts')
        const state = exportSoundState(83)
        const samples = 4800
        const context = new OfflineAudioContext(2, samples, 48000)
        const constant = (value: number) => {
            const b = context.createBuffer(1, 9600, 48000)
            b.getChannelData(0).fill(value)
            return b
        }
        const sfx = {
            normalActive: constant(0.2),
            criticalTap: constant(0.4),
            normalFlick: constant(0.3),
        }
        const bgm = { buffer: constant(0.1), offset: -83 }
        const scheduler = createSoundScheduler({
            context: context as unknown as AudioContext,
            source: () => state,
            buffers: { sfx, bgm },
            volumes: { bgm: () => 50, sfx: () => 25 },
            start: { time: 83, contextTime: 0, speed: 1 },
        })
        scheduler.startBgm()
        scheduler.schedule()
        const play = await context.startRendering()
        const blocks = []
        for await (const block of mixAudio(
            exportSoundSource(state),
            state.bpms,
            { sfx, bgm },
            {
                in: 83,
                frames: 6,
                frameRate: 60,
                bgm: true,
                sfx: true,
                bgmVolume: 50,
                sfxVolume: 25,
                fadeIn: 0,
                fadeOut: 0,
            },
        ))
            blocks.push(block)
        const output = blocks[0]!.planes[0]
        const input = play.getChannelData(0)
        let maxError = 0
        // The export also applies its clip-edge release.
        for (let i = 0; i < samples - 240; i++)
            maxError = Math.max(maxError, Math.abs(output[i]! - input[i]!))
        return {
            maxError,
            length: output.length,
            before: output[959],
            onset: output[960],
            secondBefore: output[1919],
            secondOnset: output[1920],
        }
    })
    expect(result.length).toBe(4800)
    expect(result.maxError).toBeLessThan(1e-6)
    expect(result.onset! - result.before!).toBeCloseTo(0.1, 5)
    expect(result.secondOnset! - result.secondBefore!).toBeCloseTo(0.075, 5)
})

for (const sourceRate of [44100, 48000, 96000]) {
    test(`blocks match a continuous render across hit and hold boundaries at ${sourceRate} Hz`, async ({
        page,
    }) => {
        const result = await page.evaluate(async (sourceRate) => {
            const { createMixPlan, renderMixBlock } = await import('/src/exportVideo/mix.ts')
            const { exportSoundState, exportSoundSource } =
                await import('/tests/helpers/exportVideo.ts')
            const state = exportSoundState(83)
            const makeBuffer = (seconds: number, frequency: number) => {
                const buffer = new AudioBuffer({
                    numberOfChannels: 1,
                    length: Math.round(sourceRate * seconds),
                    sampleRate: sourceRate,
                })
                const data = buffer.getChannelData(0)
                for (let i = 0; i < data.length; i++)
                    data[i] = 0.2 * Math.sin((2 * Math.PI * frequency * i) / sourceRate)
                return buffer
            }
            const buffers = {
                sfx: { normalActive: makeBuffer(0.2, 220), criticalTap: makeBuffer(0.2, 880) },
                bgm: { buffer: makeBuffer(12, 440), offset: -83 },
            }
            const settings = {
                in: 83,
                frames: 660,
                frameRate: 60 as const,
                bgm: true,
                sfx: true,
                bgmVolume: 50,
                sfxVolume: 25,
                fadeIn: 0,
                fadeOut: 0,
            }
            const plan = createMixPlan(exportSoundSource(state), state.bpms, buffers, settings)
            const first = plan.next()!
            const second = plan.next()!
            const block = await renderMixBlock(second, settings)
            const whole = await renderMixBlock(
                { ...first, length: plan.samples, voices: second.voices },
                settings,
            )
            let maxError = 0
            for (let i = 0; i < block.planes[0].length; i++)
                maxError = Math.max(
                    maxError,
                    Math.abs(block.planes[0][i]! - whole.planes[0][second.startSample + i]!),
                )
            return maxError
        }, sourceRate)
        expect(result).toBeLessThan(0.0001)
    })
}

for (const sourceRate of [48000, 96000]) {
    test(`BGM resumes at its source offset in the 130 s block at ${sourceRate} Hz`, async ({
        page,
    }) => {
        const result = await page.evaluate(async (sourceRate) => {
            const { createMixPlan, renderMixBlock } = await import('/src/exportVideo/mix.ts')
            const { exportSoundState, exportSoundSource } =
                await import('/tests/helpers/exportVideo.ts')
            const state = exportSoundState()
            const buffer = new AudioBuffer({
                numberOfChannels: 1,
                length: sourceRate * 180,
                sampleRate: sourceRate,
            })
            buffer.getChannelData(0).fill(0.25, sourceRate * 130, sourceRate * 135)
            const settings = {
                in: 0,
                frames: 180 * 60,
                frameRate: 60 as const,
                bgm: true,
                sfx: false,
                bgmVolume: 100,
                sfxVolume: 100,
                fadeIn: 0,
                fadeOut: 0,
            }
            const plan = createMixPlan(
                exportSoundSource(state),
                state.bpms,
                { sfx: {}, bgm: { buffer, offset: 0 } },
                settings,
            )
            let block = plan.next()!
            while (block.startSample < 130 * 48000) block = plan.next()!
            const rendered = await renderMixBlock(block, settings)
            return rendered.planes.map((plane) => ({
                length: plane.length,
                playing: plane[48000],
                silent: plane[6 * 48000],
            }))
        }, sourceRate)
        expect(result).toEqual([
            { length: 480000, playing: 0.25, silent: 0 },
            { length: 480000, playing: 0.25, silent: 0 },
        ])
    })
}

test('the real Opus encoder puts priming before zero and retains less than one packet of padding', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { createAudioFeeder, createAudioPacketAdapter } =
            await import('/src/exportVideo/worker/encode.ts')
        const config = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 }
        if (!(await AudioEncoder.isConfigSupported(config)).supported) return undefined
        const timestamps: number[] = []
        const adapter = createAudioPacketAdapter({
            codec: 'opus',
            samples: 800,
            emit: (input) => {
                if (input.track === 'audio') timestamps.push(input.packet.timestamp)
            },
        })
        let failure: unknown
        const encoder = new AudioEncoder({
            output: adapter.output,
            error: (e) => {
                failure = e
            },
        })
        try {
            encoder.configure(config)
            const feeder = createAudioFeeder(encoder, 800)
            feeder.pad()
            feeder.feed({ startSample: 0, planes: [new Float32Array(800), new Float32Array(800)] })
            feeder.finish()
            await encoder.flush()
            if (failure) throw failure
            return { timestamps, trim: adapter.finish() }
        } finally {
            encoder.close()
        }
    })
    expect(result, 'Chromium must provide the automated Opus path').toBeDefined()
    expect(result!.timestamps[0]).toBe(-(result!.trim.startSamples * 1e6) / 48000)
    expect(result!.trim.playableSamples).toBe(800)
    expect(result!.trim.startSamples).toBeGreaterThanOrEqual(1024)
    expect(result!.trim.paddingSamples).toBeGreaterThanOrEqual(0)
    expect(result!.trim.paddingSamples).toBeLessThan(960)
})

test('AAC calibration and the pad preserve sound within the first 1024 clip samples', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { measureAacDelay, createAudioFeeder, normalizeAacDescription } =
            await import('/src/exportVideo/worker/encode.ts')
        const config = {
            codec: 'mp4a.40.2',
            sampleRate: 48000,
            numberOfChannels: 2,
            bitrate: 192000,
        }
        if (!(await AudioEncoder.isConfigSupported(config)).supported) return undefined
        const delay = await measureAacDelay(config)
        const chunks: EncodedAudioChunk[] = []
        let decoderConfig: AudioDecoderConfig | undefined
        let failure: unknown
        const encoder = new AudioEncoder({
            error: (error) => {
                failure = error
            },
            output: (chunk, metadata) => {
                chunks.push(chunk)
                decoderConfig ??= metadata?.decoderConfig
            },
        })
        let peak = 0
        let peakSample = -1
        let decoded = 0
        const decoder = new AudioDecoder({
            error: (error) => {
                failure = error
            },
            output: (audio) => {
                try {
                    const samples = new Float32Array(audio.numberOfFrames)
                    audio.copyTo(samples, { planeIndex: 0, format: 'f32-planar' })
                    for (let i = 0; i < samples.length; i++)
                        if (Math.abs(samples[i]!) > peak) {
                            peak = Math.abs(samples[i]!)
                            peakSample = decoded + i
                        }
                    decoded += samples.length
                } finally {
                    audio.close()
                }
            },
        })
        try {
            encoder.configure(config)
            const feeder = createAudioFeeder(encoder, 4800)
            feeder.pad()
            const plane = new Float32Array(4800)
            plane[120] = 1
            feeder.feed({ startSample: 0, planes: [plane, plane] })
            feeder.finish()
            await encoder.flush()
            if (failure) throw failure
            if (!decoderConfig?.description) throw new Error('Missing AAC configuration')
            decoder.configure({
                ...decoderConfig,
                description: normalizeAacDescription(decoderConfig.description),
            })
            for (const chunk of chunks) decoder.decode(chunk)
            await decoder.flush()
            if (failure) throw failure
            return { peak, sample: peakSample - 1024 - delay }
        } finally {
            if (encoder.state !== 'closed') encoder.close()
            if (decoder.state !== 'closed') decoder.close()
        }
    })
    test.skip(!result, 'This browser does not encode AAC')
    expect(result!.peak).toBeGreaterThan(0.1)
    expect(result!.sample).toBe(120)
})
