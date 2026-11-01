import { AUDIO_PAD, AUDIO_RATE, frameTimestamp } from '../timing'
import { opusPreSkip, type AudioTiming, type MuxInput } from './encode'
import type { PacketSink, SinkConfig } from './sink'

/** Records real encoder output. It writes no container and makes no claim about playback. */
export const createTestSink = (config: SinkConfig) => {
    const inputs: MuxInput[] = []
    let frames = 0
    let audioEnd: number | undefined
    let timing: AudioTiming | undefined
    let padding: number | undefined
    let videoConfigured = false
    let closed = false
    const check = (condition: boolean, message: string) => {
        if (!condition) throw new Error(message)
    }
    const sink: PacketSink = {
        add(input) {
            check(!closed, 'Test sink is closed')
            if (input.track === 'video') {
                check(
                    input.packet.timestamp === frameTimestamp(frames, config.frameRate),
                    'Missing or misplaced video frame',
                )
                check(
                    input.packet.duration ===
                        frameTimestamp(frames + 1, config.frameRate) - input.packet.timestamp,
                    'Wrong video duration',
                )
                if (input.decoderConfig) {
                    check(
                        input.decoderConfig.codedWidth === config.codecs.video.width &&
                            input.decoderConfig.codedHeight === config.codecs.video.height,
                        'Wrong video dimensions',
                    )
                    videoConfigured = true
                }
                frames++
            } else if (input.track === 'audio') {
                check(!!config.codecs.audio && padding === undefined, 'Unexpected audio packet')
                check(
                    audioEnd === undefined || Math.abs(input.packet.timestamp - audioEnd) <= 1,
                    'Missing or misplaced audio packet',
                )
                check(input.packet.duration > 0, 'Wrong audio duration')
                if (input.timing) {
                    check(!timing && audioEnd === undefined, 'Audio timing was given twice')
                    timing = input.timing
                    check(
                        timing.sampleRate === AUDIO_RATE &&
                            timing.playableSamples === config.samples &&
                            timing.startSamples >= AUDIO_PAD &&
                            timing.endSample === timing.startSamples + config.samples,
                        'Wrong audio trim',
                    )
                    if (config.codecs.audio?.codec === 'opus') {
                        check(
                            !!input.decoderConfig?.description &&
                                opusPreSkip(input.decoderConfig.description) ===
                                    timing.startSamples,
                            'Wrong Opus pre-skip',
                        )
                    }
                }
                audioEnd = input.packet.timestamp + input.packet.duration
            } else {
                check(padding === undefined && !!timing, 'Unexpected audio end')
                padding = input.paddingSamples
                check(
                    Number.isSafeInteger(padding) &&
                        padding >= 0 &&
                        audioEnd !== undefined &&
                        Math.round((audioEnd * AUDIO_RATE) / 1e6) - padding ===
                            timing?.playableSamples,
                    'Wrong audio padding',
                )
            }
            inputs.push(input)
            return Promise.resolve()
        },
        finalize() {
            check(
                !closed && videoConfigured && frames === config.frames,
                'Video output is incomplete',
            )
            check(
                !config.codecs.audio || (!!timing && padding !== undefined),
                'Audio output is incomplete',
            )
            closed = true
            return Promise.resolve({
                inputs,
                frames,
                timing,
                padding,
                duration: frameTimestamp(frames, config.frameRate),
            })
        },
        abort() {
            closed = true
            inputs.length = 0
            return Promise.resolve()
        },
    }
    return sink
}
