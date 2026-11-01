import {
    ALL_FORMATS,
    AudioSampleSink,
    BufferSource,
    EncodedPacketSink,
    Input,
    VideoSampleSink,
} from 'mediabunny'

export const readVideo = async (bytes: number[]) => {
    const input = new Input({
        formats: ALL_FORMATS,
        source: new BufferSource(new Uint8Array(bytes)),
    })
    try {
        const video = await input.getPrimaryVideoTrack()
        const audio = await input.getPrimaryAudioTrack()
        if (!video || !audio) throw new Error('Missing media track')
        let frames = 0
        let firstVideo: number | undefined
        let videoEnd = 0
        for await (const packet of new EncodedPacketSink(video).packets()) {
            firstVideo ??= packet.timestamp
            videoEnd = packet.timestamp + packet.duration
            frames++
        }
        let audioEnd = 0
        let firstAudio: number | undefined
        let firstSound: number | undefined
        let earlyPeak = 0
        for await (const sample of new AudioSampleSink(audio).samples()) {
            try {
                firstAudio ??= sample.timestamp
                const plane = new Float32Array(sample.numberOfFrames)
                sample.copyTo(plane, { planeIndex: 0, format: 'f32-planar' })
                for (let i = 0; i < plane.length; i++) {
                    const time = sample.timestamp + i / sample.sampleRate
                    const magnitude = Math.abs(plane[i]!)
                    if (magnitude > 0.1) firstSound ??= time
                    if (time >= 0 && time < 1024 / 48000) earlyPeak = Math.max(earlyPeak, magnitude)
                }
                audioEnd = sample.timestamp + sample.duration
            } finally {
                sample.close()
            }
        }
        const frame = await new VideoSampleSink(video).getSample(0)
        if (!frame) throw new Error('Video could not be decoded')
        frame.close()
        return {
            frames,
            firstVideo,
            videoEnd,
            audioEnd,
            firstAudio,
            firstSound,
            earlyPeak,
            width: await video.getDisplayWidth(),
            height: await video.getDisplayHeight(),
            colorSpace: (await video.getDecoderConfig())?.colorSpace,
            duration: await input.computeDuration(),
        }
    } finally {
        input.dispose()
    }
}
