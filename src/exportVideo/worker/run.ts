import { AudioFailure } from '../error'
import { AUDIO_RATE, audioUnits, type AudioBlock } from '../timing'
import type { ExportStart } from '../types'
import type { ExportWarning } from '../warnings'
import {
    createAudioFeeder,
    createAudioPacketAdapter,
    createVideoColor,
    createVideoPacketAdapter,
} from './encode'
import { measureEncoderColor } from './encoderColor'
import { createFrameLoop } from './loop'
import type { createExportRenderer } from './renderer'
import type { PacketSink } from './sink'

/** A message task yields even when both codecs consume input synchronously. */
const yieldTask = () =>
    new Promise<void>((resolve) => {
        const channel = new MessageChannel()
        channel.port1.onmessage = () => {
            channel.port1.close()
            channel.port2.close()
            resolve()
        }
        channel.port2.postMessage(null)
    })

export const runExport = async (
    start: ExportStart,
    options: {
        signal: AbortSignal
        renderer: ReturnType<typeof createExportRenderer>
        sink: PacketSink
        block: () => Promise<AudioBlock | undefined>
        progress: (frames: number, bitmap?: ImageBitmap) => void
        finishing: () => Promise<void>
        beforeCapture?: (renderer: ReturnType<typeof createExportRenderer>, index: number) => void
        inspect?: (frame: VideoFrame, index: number) => Promise<void>
    },
): Promise<{ result: unknown; warnings: ExportWarning[] }> => {
    const { settings: s } = start
    const { renderer } = options
    let video: VideoEncoder | undefined
    let audio: AudioEncoder | undefined
    const loop = createFrameLoop({
        signal: options.signal,
        audio: !!start.codecs.audio,
        queueSize: (track) => (track === 'video' ? video : audio)?.encodeQueueSize ?? 0,
        write: (input) => options.sink.add(input),
    })
    /** Runs one step of the sound; its failure ends the export as an `AudioFailure`. */
    const forAudio = <T>(step: () => T): T => {
        try {
            return step()
        } catch (error) {
            throw new AudioFailure(error)
        }
    }
    const audioFailed = (error: unknown) => {
        loop.fail(new AudioFailure(error))
    }
    try {
        // Without a measurement, the file declares the bitstream's colour and the encoder's report.
        const color = createVideoColor(
            await loop.guard(
                measureEncoderColor(
                    start.codecs.video,
                    s.frameRate,
                    renderer.captureStripes,
                    options.signal,
                ),
            ),
        )
        const frames = createVideoPacketAdapter({
            codec: start.codecs.video.codec,
            width: s.width,
            height: s.height,
            frames: s.frames,
            frameRate: s.frameRate,
            color,
            emit: (input) => {
                loop.emit(input)
            },
        })
        /** Ends the picture at the video already encoded; the sound goes on. */
        const endVideo = (error: unknown) => {
            frames.end(error)
            loop.wake()
        }
        video = new VideoEncoder({
            error: endVideo,
            output: (chunk, metadata) => {
                try {
                    frames.output(chunk, metadata)
                } catch (error) {
                    endVideo(error)
                }
            },
        })
        video.addEventListener('dequeue', loop.wake)
        video.configure(start.codecs.video)
        const feedAudio = async () => {
            const config = start.codecs.audio
            if (!config) return
            const codec = start.codecs.format === 'mp4' ? 'aac' : 'opus'
            const adapter = createAudioPacketAdapter({
                codec,
                samples: start.samples,
                aacDelay: start.codecs.aacDelay,
                emit: (input) => {
                    loop.emit(input)
                },
            })
            const encoder = forAudio(
                () =>
                    new AudioEncoder({
                        error: audioFailed,
                        output: (chunk, metadata) => {
                            try {
                                adapter.output(chunk, metadata)
                            } catch (error) {
                                audioFailed(error)
                            }
                        },
                    }),
            )
            audio = encoder
            encoder.addEventListener('dequeue', loop.wake)
            forAudio(() => {
                encoder.configure(config)
            })
            const feeder = createAudioFeeder(encoder, start.samples, codec)
            for (;;) {
                const block = await loop.guard(options.block())
                if (!block) break
                for (const unit of forAudio(() => [...audioUnits(block)])) {
                    const length = unit.planes[0].length
                    const end = (unit.startSample + length) / AUDIO_RATE
                    await loop.room('audio', end)
                    forAudio(() => {
                        feeder.feed(unit)
                    })
                    loop.submitted('audio', end)
                }
            }
            forAudio(() => {
                feeder.finish()
            })
            loop.complete('audio')
            return adapter
        }
        const audioFed = feedAudio().catch((error: unknown) => {
            loop.fail(error)
            throw error
        })
        // Observe a rejection even if drawing fails before the audio feeder is awaited.
        void audioFed.catch(() => undefined)
        let incomplete = 0
        /** Why capture stopped early. The frames already submitted are still flushed. */
        let stopped: { cause: unknown } | undefined
        let lastProgress = -Infinity
        for (let i = 0; i < s.frames; i++) {
            await loop.room('video', (i + 1) / s.frameRate)
            if (frames.ended) break
            options.beforeCapture?.(renderer, i)
            let captured: ReturnType<typeof renderer.capture>
            try {
                captured = renderer.capture(i)
            } catch (error) {
                stopped = { cause: error }
                break
            }
            const { frame, complete } = captured
            if (!complete) incomplete++
            try {
                try {
                    video.encode(frame, { keyFrame: i % (2 * s.frameRate) === 0 })
                } catch (error) {
                    stopped = { cause: error }
                    break
                }
                if (options.inspect) await loop.guard(options.inspect(frame, i))
            } finally {
                frame.close()
            }
            loop.submitted('video', (i + 1) / s.frameRate)
            if (performance.now() - lastProgress >= 500 || i === s.frames - 1) {
                lastProgress = performance.now()
                // Without the image, progress is shown as a number only.
                const bitmap = await loop.guard(
                    createImageBitmap(renderer.canvas, {
                        resizeWidth: 320,
                        resizeHeight: Math.max(1, Math.round((320 * s.height) / s.width)),
                    }).catch(() => undefined),
                    (late) => {
                        late?.close()
                    },
                )
                options.progress(i + 1, bitmap)
            }
            if ((i + 1) % (10 * s.frameRate) === 0) await loop.guard(yieldTask())
        }
        loop.complete('video')
        await loop.audioFed()
        const adapter = await loop.guard(audioFed)
        if (video.state === 'configured') await loop.guard(video.flush().catch(endVideo))
        if (stopped) frames.end(stopped.cause)
        const encoder = audio
        if (encoder)
            await loop.guard(
                encoder.flush().catch((error: unknown) => {
                    throw new AudioFailure(error)
                }),
            )
        const audioWarnings = adapter ? forAudio(() => adapter.finish()).warnings : []
        await loop.drained()
        const warnings = frames.finish()
        if (incomplete) warnings.push({ code: 'framesIncomplete', count: incomplete })
        const result = await loop.guard(options.sink.finalize())
        await loop.guard(options.finishing())
        return { result, warnings: [...warnings, ...audioWarnings] }
    } finally {
        if (video?.state !== 'closed') video?.close()
        if (audio?.state !== 'closed') audio?.close()
        loop.dispose()
    }
}
