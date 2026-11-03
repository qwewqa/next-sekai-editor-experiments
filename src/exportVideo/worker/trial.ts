import { BufferTarget } from 'mediabunny'
import type { TrialConfig } from '../codecs'
import { createVideoColor, createVideoPacketAdapter, type MuxInput } from './encode'
import { createMuxSink } from './mux'
import type { PacketSink } from './sink'

export type TrialOutput = { chunk: EncodedVideoChunk; metadata?: EncodedVideoChunkMetadata }

/** Whether the export's video adapter and muxer take this output for `frames` submitted frames. */
export const usableTrial = async (
    config: TrialConfig,
    outputs: readonly TrialOutput[],
    frames: number,
) => {
    let sink: PacketSink | undefined
    try {
        const inputs: MuxInput[] = []
        const adapter = createVideoPacketAdapter({
            width: config.width,
            height: config.height,
            frames,
            frameRate: config.framerate,
            // Colour without a measurement: the trial checks what the muxer accepts.
            color: createVideoColor(),
            emit: (input) => inputs.push(input),
        })
        for (let i = 0; i < frames; i++) adapter.submit()
        for (const { chunk, metadata } of outputs) adapter.output(chunk, metadata)
        adapter.finish()
        sink = await createMuxSink(
            {
                codecs: {
                    supported: true,
                    format: config.codec.startsWith('avc1.') ? 'mp4' : 'webm',
                    video: config,
                },
                frames,
                frameRate: config.framerate,
                samples: 0,
            },
            new BufferTarget(),
        )
        for (const input of inputs) await sink.add(input)
        await sink.finalize()
        return true
    } catch {
        await sink?.abort().catch(() => undefined)
        return false
    }
}
