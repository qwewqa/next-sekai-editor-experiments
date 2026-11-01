import { ALL_FORMATS, BufferSource, Input, VideoSampleSink } from 'mediabunny'
import { createCodecProbes } from '../../src/exportVideo/codecs'
import { videoPacket, type MuxInput } from '../../src/exportVideo/worker/encode'
import { openMuxOutput } from '../../src/exportVideo/worker/mux'

/** OPFS handles exercise the picked target's writable stream without opening a picker. */
export const muxPickedVideo = async (format: 'webm' | 'mp4', cancel: boolean | 'writing') => {
    const codecs = await createCodecProbes().resolve({
        format,
        width: 320,
        height: 180,
        frameRate: 30,
        videoBitrate: 1_000_000,
        audioBitrate: 128_000,
        bgm: false,
        sfx: false,
    })
    if (!codecs.supported) return undefined
    const root = await navigator.storage.getDirectory()
    const name = `mux-${crypto.randomUUID()}.${format}`
    const handle = await root.getFileHandle(name, { create: true })
    const controller = new AbortController()
    let writes = 0
    let beforeCommit: number | undefined
    const createWritable = handle.createWritable.bind(handle)
    handle.createWritable = async (options) => {
        const writable = await createWritable(options)
        const write = writable.write.bind(writable)
        writable.write = async (data) => {
            await write(data)
            writes++
            if (cancel === 'writing') {
                beforeCommit = (await handle.getFile()).size
                controller.abort()
            }
        }
        return writable
    }
    const output = await openMuxOutput(
        { codecs, frames: 1, frameRate: 30, samples: 1600 },
        {
            kind: 'picked',
            pick: { handle, lastModified: (await handle.getFile()).lastModified },
        },
        controller.signal,
    )
    const packets: MuxInput[] = []
    let failure: unknown
    const encoder = new VideoEncoder({
        output: (chunk, metadata) => {
            packets.push(videoPacket(chunk, metadata))
        },
        error: (error) => {
            failure = error
        },
    })
    try {
        const canvas = new OffscreenCanvas(320, 180)
        const context = canvas.getContext('2d')!
        const colors = [
            '#000000',
            '#404040',
            '#808080',
            '#c0c0c0',
            '#ffffff',
            '#ff0000',
            '#00ff00',
            '#c89878',
        ]
        colors.forEach((color, i) => {
            context.fillStyle = color
            context.fillRect(i * 40, 0, 40, 180)
        })
        const original = context.getImageData(0, 0, 320, 180).data
        encoder.configure(codecs.video)
        const frame = new VideoFrame(canvas, { timestamp: 0, duration: 33333 })
        try {
            encoder.encode(frame, { keyFrame: true })
        } finally {
            frame.close()
        }
        await encoder.flush()
        if (failure) throw failure
        const first = packets[0]!
        if (first.track !== 'video' || !first.decoderConfig)
            throw new Error('Missing video configuration')
        let directPixels: Uint8ClampedArray<ArrayBufferLike> | undefined
        let directColor: VideoColorSpaceInit | undefined
        const decoder = new VideoDecoder({
            error: (error) => {
                failure = error
            },
            output: (frame) => {
                try {
                    directColor = frame.colorSpace.toJSON()
                    context.drawImage(frame, 0, 0)
                    directPixels = context.getImageData(0, 0, 320, 180).data
                } finally {
                    frame.close()
                }
            },
        })
        try {
            decoder.configure(first.decoderConfig)
            for (const packet of packets) {
                if (packet.track !== 'video') continue
                decoder.decode(new EncodedVideoChunk(packet.packet))
            }
            await decoder.flush()
            if (failure) throw failure
        } finally {
            decoder.close()
        }
        for (const packet of packets) await output.sink.add(packet)
        let cancelledDuringWrite = false
        try {
            await output.sink.finalize()
        } catch (error) {
            if (
                cancel !== 'writing' ||
                !(error instanceof DOMException && error.name === 'AbortError')
            )
                throw error
            cancelledDuringWrite = true
        }
        if (cancel !== 'writing') beforeCommit = (await handle.getFile()).size
        if (cancel) {
            controller.abort()
            await output.sink.abort()
            await output.abort()
            let removed = false
            try {
                await root.getFileHandle(name)
            } catch (error) {
                if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error
                removed = true
            }
            return { beforeCommit, removed, writes, cancelledDuringWrite }
        }
        await output.commit()
        const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer())
        const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) })
        try {
            const track = (await input.getPrimaryVideoTrack())!
            const config = await track.getDecoderConfig()
            const sample = (await new VideoSampleSink(track).getSample(0))!
            try {
                const decoded = sample.toVideoFrame()
                try {
                    context.drawImage(decoded, 0, 0)
                } finally {
                    decoded.close()
                }
            } finally {
                sample.close()
            }
            const pixels = context.getImageData(0, 0, 320, 180).data
            let maxError = 0
            let directMaxError = 0
            let muxError = 0
            for (let patch = 0; patch < colors.length; patch++)
                for (let channel = 0; channel < 3; channel++) {
                    const i = (90 * 320 + patch * 40 + 20) * 4 + channel
                    maxError = Math.max(maxError, Math.abs(pixels[i]! - original[i]!))
                    directMaxError = Math.max(
                        directMaxError,
                        Math.abs(directPixels![i]! - original[i]!),
                    )
                    muxError = Math.max(muxError, Math.abs(pixels[i]! - directPixels![i]!))
                }
            const first = packets[0]!
            return {
                beforeCommit,
                maxError,
                directColor,
                directMaxError,
                muxError,
                expectedColor:
                    first.track === 'video' ? first.decoderConfig?.colorSpace : undefined,
                actualColor: config?.colorSpace,
                size: bytes.length,
                indexBeforeMedia:
                    format === 'mp4'
                        ? new TextDecoder('latin1').decode(bytes).indexOf('moov') <
                          new TextDecoder('latin1').decode(bytes).indexOf('mdat')
                        : undefined,
            }
        } finally {
            input.dispose()
        }
    } finally {
        if (encoder.state !== 'closed') encoder.close()
        await output.sink.abort()
        await output.abort()
        await root.removeEntry(name).catch((error: unknown) => {
            if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error
        })
    }
}
