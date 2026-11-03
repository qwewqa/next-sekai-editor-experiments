import { AUDIO_PAD, AUDIO_RATE, frameTimestamp } from '../timing'
import { AUDIO_SHORTFALL, opusPreSkip, type AudioTiming, type MuxInput } from './encode'
import type { PacketSink, SinkConfig } from './sink'

/** Records real encoder output. It writes no container and makes no claim about playback. */
export const createTestSink = (config: SinkConfig) => {
    const inputs: MuxInput[] = []
    let frames = 0
    const seen = new Set<number>()
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
                // Packets arrive in encoded order, each at its own frame's timestamp.
                const index = Math.round((input.packet.timestamp * config.frameRate) / 1e6)
                check(
                    index >= 0 &&
                        index < config.frames &&
                        !seen.has(index) &&
                        input.packet.timestamp === frameTimestamp(index, config.frameRate),
                    'Missing or misplaced video frame',
                )
                seen.add(index)
                check(
                    input.packet.duration ===
                        frameTimestamp(index + 1, config.frameRate) - input.packet.timestamp,
                    'Wrong video duration',
                )
                check(
                    frames > 0 || input.packet.type === 'key',
                    'First video frame is not a key frame',
                )
                if (input.decoderConfig) {
                    check(!videoConfigured && frames === 0, 'Video configuration was given twice')
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
                // Without padding, the audio may end short by the tolerance the export accepts.
                const short =
                    audioEnd === undefined || !timing
                        ? -1
                        : timing.playableSamples -
                          (Math.round((audioEnd * AUDIO_RATE) / 1e6) - padding)
                check(
                    Number.isSafeInteger(padding) &&
                        padding >= 0 &&
                        short >= 0 &&
                        short <= (padding === 0 ? AUDIO_SHORTFALL : 0),
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
