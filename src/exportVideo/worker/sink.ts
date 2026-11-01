import type { CodecSupport } from '../codecs'
import type { MuxInput } from './encode'

/** add resolves after the packet's writes. finalize never commits the target. */
export type PacketSink = {
    add(input: MuxInput): Promise<void>
    finalize(): Promise<unknown>
    abort(): Promise<void>
}
export type SinkConfig = {
    codecs: Extract<CodecSupport, { supported: true }>
    frames: number
    frameRate: 30 | 60
    samples: number
}
