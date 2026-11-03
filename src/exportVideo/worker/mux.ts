import {
    BufferTarget,
    EncodedAudioPacketSource,
    EncodedPacket,
    EncodedVideoPacketSource,
    Mp4OutputFormat,
    Output,
    StreamTarget,
    WebMOutputFormat,
    type Target,
} from 'mediabunny'
import type { ExportTarget } from '../types'
import { AAC_DELAY_ESTIMATE, aacPacketBound, videoPacketBound } from './encode'
import type { WorkerOutput } from './export.worker'
import type { PacketSink, SinkConfig } from './sink'
import { openPickedTarget, openStagedFile, type PositionTarget } from './target'

export type MuxResult = { frames: number; paddingSamples?: number; buffer?: ArrayBuffer }

export const createMuxSink = async (config: SinkConfig, target: Target): Promise<PacketSink> => {
    const mp4 = config.codecs.format === 'mp4'
    const output = new Output({
        format: mp4 ? new Mp4OutputFormat({ fastStart: 'reserve' }) : new WebMOutputFormat(),
        target,
    })
    const video = new EncodedVideoPacketSource(mp4 ? 'avc' : 'vp9')
    const audio = config.codecs.audio
        ? new EncodedAudioPacketSource(mp4 ? 'aac' : 'opus')
        : undefined
    // The adapters end a track before it passes these bounds.
    output.addVideoTrack(video, {
        frameRate: config.frameRate,
        maximumPacketCount: videoPacketBound(config.frames),
    })
    if (audio)
        output.addAudioTrack(audio, {
            maximumPacketCount: mp4
                ? aacPacketBound(config.samples, config.codecs.aacDelay ?? AAC_DELAY_ESTIMATE)
                : undefined,
        })
    let frames = 0
    let paddingSamples: number | undefined
    await output.start()
    return {
        async add(input) {
            if (input.track === 'audioEnd') {
                paddingSamples = input.paddingSamples
                return
            }
            const { data, type, timestamp, duration } = input.packet
            const packet = new EncodedPacket(data, type, timestamp / 1e6, duration / 1e6)
            if (input.track === 'video') {
                await video.add(packet, { decoderConfig: input.decoderConfig })
                frames++
            } else {
                if (!audio) throw new Error('Unexpected audio packet')
                // Negative timestamps supply WebM CodecDelay and the MP4 edit list.
                await audio.add(packet, { decoderConfig: input.decoderConfig })
            }
        },
        async finalize(): Promise<MuxResult> {
            if (!frames || (audio && paddingSamples === undefined))
                throw new Error('Muxed output is incomplete')
            await output.finalize()
            return {
                frames,
                paddingSamples,
                buffer: target instanceof BufferTarget ? (target.buffer ?? undefined) : undefined,
            }
        },
        abort: () => (output.state === 'finalized' ? Promise.resolve() : output.cancel()),
    }
}

/** Stream closure finishes the container. Only the worker's commit closes the file. */
export const muxStreamTarget = (target: PositionTarget) =>
    new StreamTarget(
        new WritableStream({
            write: ({ data, position }) => target.write(data, position),
        }),
        { chunked: true, chunkSize: 16 * 1024 * 1024 },
    )

export const openMuxOutput = async (
    config: SinkConfig,
    destination: ExportTarget,
    signal: AbortSignal,
): Promise<WorkerOutput> => {
    let file: PositionTarget | undefined
    let sink: PacketSink | undefined
    try {
        const target =
            destination.kind === 'memory'
                ? new BufferTarget()
                : muxStreamTarget(
                      (file =
                          destination.kind === 'picked'
                              ? await openPickedTarget(destination.pick, signal)
                              : await openStagedFile(destination.name, signal)),
                  )
        const packets = await createMuxSink(config, target)
        sink = packets
        signal.throwIfAborted()
        return {
            sink: {
                async add(input) {
                    signal.throwIfAborted()
                    await packets.add(input)
                    signal.throwIfAborted()
                },
                async finalize() {
                    signal.throwIfAborted()
                    const result = await packets.finalize()
                    signal.throwIfAborted()
                    return result
                },
                abort: () => packets.abort(),
            },
            commit: async () => {
                signal.throwIfAborted()
                await file?.close()
            },
            abort: async () => {
                await file?.abort()
            },
        }
    } catch (error) {
        await sink?.abort()
        await file?.abort()
        throw error
    }
}
