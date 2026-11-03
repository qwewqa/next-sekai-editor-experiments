import {
    ALL_FORMATS,
    AudioSampleSink,
    BufferSource,
    EncodedPacketSink,
    Input,
    VideoSampleSink,
    type InputAudioTrack,
} from 'mediabunny'

const readAudio = async (track: InputAudioTrack) => {
    let first: number | undefined
    let end = 0
    let peak = 0
    let firstSound: number | undefined
    let earlyPeak = 0
    for await (const sample of new AudioSampleSink(track).samples()) {
        try {
            first ??= sample.timestamp
            const plane = new Float32Array(sample.numberOfFrames)
            sample.copyTo(plane, { planeIndex: 0, format: 'f32-planar' })
            for (let i = 0; i < plane.length; i++) {
                const time = sample.timestamp + i / sample.sampleRate
                const magnitude = Math.abs(plane[i]!)
                peak = Math.max(peak, magnitude)
                if (magnitude > 0.1) firstSound ??= time
                if (time >= 0 && time < 1024 / 48000) earlyPeak = Math.max(earlyPeak, magnitude)
            }
            end = sample.timestamp + sample.duration
        } finally {
            sample.close()
        }
    }
    return {
        codec: await track.getCodec(),
        channels: await track.getNumberOfChannels(),
        first,
        end,
        /** The end the container presents, which can be earlier than the decoded end. */
        presentedEnd: await track.computeDuration(),
        peak,
        firstSound,
        earlyPeak,
    }
}

/** The tracks of a file, where the audio track may be absent. */
export const readTracks = async (bytes: number[]) => {
    const input = new Input({
        formats: ALL_FORMATS,
        source: new BufferSource(new Uint8Array(bytes)),
    })
    try {
        const [video] = await input.getVideoTracks()
        const [track] = await input.getAudioTracks()
        if (!video) throw new Error('Missing video track')
        let frames = 0
        let firstVideo: number | undefined
        let videoEnd = 0
        for await (const packet of new EncodedPacketSink(video).packets()) {
            firstVideo ??= packet.timestamp
            videoEnd = packet.timestamp + packet.duration
            frames++
        }
        const frame = await new VideoSampleSink(video).getSample(0)
        if (!frame) throw new Error('Video could not be decoded')
        frame.close()
        const audio = track && (await readAudio(track))
        return {
            format: (await input.getFormat()).name,
            trackCount: (await input.getTracks()).length,
            videoCodec: await video.getCodec(),
            colorSpace: (await video.getDecoderConfig())?.colorSpace,
            frames,
            firstVideo,
            videoEnd,
            width: await video.getDisplayWidth(),
            height: await video.getDisplayHeight(),
            duration: await input.computeDuration(),
            audio,
        }
    } finally {
        input.dispose()
    }
}

/** A file with video and audio, with the audio's timing beside the video's. */
export const readVideo = async (bytes: number[]) => {
    const { audio, ...video } = await readTracks(bytes)
    if (!audio) throw new Error('Missing audio track')
    return {
        ...video,
        firstAudio: audio.first,
        audioEnd: audio.end,
        audioPresentedEnd: audio.presentedEnd,
        firstSound: audio.firstSound,
        earlyPeak: audio.earlyPeak,
    }
}
