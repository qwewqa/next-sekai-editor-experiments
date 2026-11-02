import { AUDIO_RATE, audioUnits, frameTimestamp, type AudioBlock } from '../timing'
import type { ExportStart } from '../types'
import { createAudioFeeder, createAudioPacketAdapter, videoPacket } from './encode'
import { measureEncoderColor } from './encoderColor'
import { createFrameLoop } from './loop'
import { createExportRenderer } from './renderer'
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
        renderer?: ReturnType<typeof createExportRenderer>
        sink: PacketSink
        block: () => Promise<AudioBlock | undefined>
        progress: (frames: number, bitmap?: ImageBitmap) => void
        finishing: () => Promise<void>
        beforeCapture?: (renderer: ReturnType<typeof createExportRenderer>, index: number) => void
        inspect?: (frame: VideoFrame, index: number) => Promise<void>
    },
) => {
    const { settings: s } = start
    let video: VideoEncoder | undefined
    let audio: AudioEncoder | undefined
    let renderer: ReturnType<typeof createExportRenderer> | undefined
    const loop = createFrameLoop({
        signal: options.signal,
        audio: !!start.codecs.audio,
        queueSize: (track) => (track === 'video' ? video : audio)?.encodeQueueSize ?? 0,
        write: (input) => options.sink.add(input),
    })
    let emitted = 0
    const metadataState = { configured: false }
    try {
        renderer = options.renderer ?? createExportRenderer(start, loop.fail)
        // The measurement only corrects the colour label. If it fails, the file keeps the
        // encoder's own label.
        const color = await loop.guard(
            measureEncoderColor(start.codecs.video, s.frameRate, renderer.captureStripes).catch(
                () => undefined,
            ),
        )
        video = new VideoEncoder({
            error: loop.fail,
            output: (chunk, metadata) => {
                try {
                    if (
                        chunk.timestamp !== frameTimestamp(emitted, s.frameRate) ||
                        chunk.duration !==
                            frameTimestamp(emitted + 1, s.frameRate) - chunk.timestamp
                    )
                        throw new Error('Missing or misplaced encoded frame')
                    if (
                        metadata?.decoderConfig &&
                        (metadata.decoderConfig.codedWidth !== s.width ||
                            metadata.decoderConfig.codedHeight !== s.height)
                    )
                        throw new Error('Encoded dimensions changed')
                    if (metadata?.decoderConfig) metadataState.configured = true
                    emitted++
                    loop.emit(videoPacket(chunk, metadata, color))
                } catch (error) {
                    loop.fail(error)
                }
            },
        })
        video.addEventListener('dequeue', loop.wake)
        video.configure(start.codecs.video)
        const feedAudio = async () => {
            if (!start.codecs.audio) return
            const adapter = createAudioPacketAdapter({
                codec: start.codecs.format === 'mp4' ? 'aac' : 'opus',
                samples: start.samples,
                aacDelay: start.aacDelay,
                emit: (input) => {
                    loop.emit(input)
                },
            })
            audio = new AudioEncoder({
                error: loop.fail,
                output: (chunk, metadata) => {
                    try {
                        adapter.output(chunk, metadata)
                    } catch (error) {
                        loop.fail(error)
                    }
                },
            })
            audio.addEventListener('dequeue', loop.wake)
            audio.configure(start.codecs.audio)
            const feeder = createAudioFeeder(audio, start.samples)
            await loop.room('audio', 0)
            feeder.pad()
            for (;;) {
                const block = await loop.guard(options.block())
                if (!block) break
                for (const unit of audioUnits(block)) {
                    const length = unit.planes[0].length
                    const end = (unit.startSample + length) / AUDIO_RATE
                    await loop.room('audio', end)
                    feeder.feed(unit)
                    loop.submitted('audio', end)
                }
            }
            feeder.finish()
            loop.complete('audio')
            return adapter
        }
        const audioFed = feedAudio().catch((error: unknown) => {
            loop.fail(error)
            throw error
        })
        // Observe a rejection even if drawing fails before the audio feeder is awaited.
        void audioFed.catch(() => undefined)
        let lastProgress = -Infinity
        for (let i = 0; i < s.frames; i++) {
            await loop.room('video', (i + 1) / s.frameRate)
            options.beforeCapture?.(renderer, i)
            const frame = renderer.capture(i)
            try {
                video.encode(frame, { keyFrame: i % (2 * s.frameRate) === 0 })
                if (options.inspect) await loop.guard(options.inspect(frame, i))
            } finally {
                frame.close()
            }
            loop.submitted('video', (i + 1) / s.frameRate)
            if (performance.now() - lastProgress >= 500 || i === s.frames - 1) {
                lastProgress = performance.now()
                const bitmap = await loop.guard(
                    createImageBitmap(renderer.canvas, {
                        resizeWidth: 320,
                        resizeHeight: Math.max(1, Math.round((320 * s.height) / s.width)),
                    }),
                    (late) => {
                        late.close()
                    },
                )
                options.progress(i + 1, bitmap)
            }
            if ((i + 1) % (10 * s.frameRate) === 0) await loop.guard(yieldTask())
        }
        loop.complete('video')
        await loop.audioFed()
        const adapter = await loop.guard(audioFed)
        await loop.guard(video.flush())
        if (audio) await loop.guard(audio.flush())
        adapter?.finish()
        await loop.drained()
        if (emitted !== s.frames || !metadataState.configured)
            throw new Error('Encoded video is incomplete')
        const result = await loop.guard(options.sink.finalize())
        await loop.guard(options.finishing())
        return result
    } finally {
        if (video?.state !== 'closed') video?.close()
        if (audio?.state !== 'closed') audio?.close()
        if (!options.renderer) renderer?.dispose()
        loop.dispose()
    }
}
