import { ALL_FORMATS, BufferSource, Input, VideoSampleSink } from 'mediabunny'
import { createCodecProbes } from '../../src/exportVideo/codecs'
import { createVideoColor, videoPacket, type MuxInput } from '../../src/exportVideo/worker/encode'
import { measureEncoderColor, STRIPES } from '../../src/exportVideo/worker/encoderColor'
import { openMuxOutput } from '../../src/exportVideo/worker/mux'

/** OPFS handles exercise the picked target's writable stream without opening a picker. */
export const muxPickedVideo = async (
    format: 'webm' | 'mp4',
    cancel: boolean | 'writing',
    pickedHandle?: FileSystemFileHandle,
) => {
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
    const handle = pickedHandle ?? (await root.getFileHandle(name, { create: true }))
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
    let color = createVideoColor()
    const encoder = new VideoEncoder({
        output: (chunk, metadata) => {
            packets.push(videoPacket(chunk, metadata, color))
        },
        error: (error) => {
            failure = error
        },
    })
    try {
        const canvas = new OffscreenCanvas(320, 180)
        const context = canvas.getContext('2d')!
        // The file declares the measured conversion, as an export does, so colours round-trip.
        color = createVideoColor(
            await measureEncoderColor(codecs.video, 30, (edges) => {
                STRIPES.forEach(([r, g, b], i) => {
                    context.fillStyle = `rgb(${r} ${g} ${b})`
                    context.fillRect(edges[i]!, 0, edges[i + 1]! - edges[i]!, 180)
                })
                return new VideoFrame(canvas, { timestamp: 0, duration: 33333 })
            }),
        )
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
        let bitstreamColor: VideoColorSpaceInit | undefined
        let rawModelError = 0
        let rawPatches: number[][] = []
        let decoded: VideoFrame | undefined
        const decoder = new VideoDecoder({
            error: (error) => {
                failure = error
            },
            output: (frame) => {
                decoded = frame
            },
        })
        try {
            for (const metadata of format === 'mp4' ? [true, false] : [true]) {
                decoder.configure({
                    ...first.decoderConfig,
                    colorSpace: metadata ? first.decoderConfig.colorSpace : undefined,
                })
                for (const packet of packets) {
                    if (packet.track !== 'video') continue
                    decoder.decode(new EncodedVideoChunk(packet.packet))
                }
                await decoder.flush()
                if (failure) throw failure
                if (!decoded) throw new Error('Missing decoded video frame')
                if (metadata) {
                    directColor = decoded.colorSpace.toJSON()
                    context.drawImage(decoded, 0, 0)
                    directPixels = context.getImageData(0, 0, 320, 180).data
                    // Read native YUV planes; an RGB copy would use the decoder's colour tags.
                    if (decoded.format !== 'I420' && decoded.format !== 'NV12')
                        throw new Error(`Unexpected decoded format: ${decoded.format}`)
                    const raw = new Uint8Array(decoded.allocationSize())
                    const layout = await decoded.copyTo(raw)
                    rawPatches = colors.map((_, i) => {
                        const x = i * 40 + 20
                        const y = raw[layout[0]!.offset + 90 * layout[0]!.stride + x]!
                        const u = layout[1]!
                        if (decoded!.format === 'NV12') {
                            const at = u.offset + 45 * u.stride + x
                            return [y, raw[at]!, raw[at + 1]!]
                        }
                        const v = layout[2]!
                        return [
                            y,
                            raw[u.offset + 45 * u.stride + x / 2]!,
                            raw[v.offset + 45 * v.stride + x / 2]!,
                        ]
                    })
                    const color = first.decoderConfig.colorSpace!
                    if (!['bt709', 'bt470bg', 'smpte170m'].includes(color.matrix ?? ''))
                        throw new Error(`Unexpected YUV matrix: ${color.matrix}`)
                    const [kr, kb] =
                        color.matrix === 'bt709'
                            ? ([0.2126, 0.0722] as const)
                            : ([0.299, 0.114] as const)
                    for (const [i, patch] of rawPatches.entries()) {
                        const at = (90 * 320 + i * 40 + 20) * 4
                        const r = original[at]!
                        const g = original[at + 1]!
                        const b = original[at + 2]!
                        const y = kr * r + (1 - kr - kb) * g + kb * b
                        const expected = [
                            color.fullRange ? y : 16 + (219 * y) / 255,
                            128 + ((b - y) / (2 * (1 - kb))) * (color.fullRange ? 1 : 224 / 255),
                            128 + ((r - y) / (2 * (1 - kr))) * (color.fullRange ? 1 : 224 / 255),
                        ]
                        rawModelError = Math.max(
                            rawModelError,
                            ...patch.map((value, channel) => Math.abs(value - expected[channel]!)),
                        )
                    }
                } else bitstreamColor = decoded.colorSpace.toJSON()
                decoded.close()
                decoded = undefined
            }
        } finally {
            decoded?.close()
            decoder.close()
        }
        if (format === 'webm') {
            // VP9 profile 0 key frame: marker/profile/flags, sync code, then colour and range.
            // Chromium uses codec-string defaults when decoderConfig.colorSpace is absent.
            const data = first.packet.data
            if (
                (data[0]! & 252) !== 128 ||
                data[1] !== 0x49 ||
                data[2] !== 0x83 ||
                data[3] !== 0x42
            )
                throw new Error('Expected a VP9 profile 0 key frame')
            const space = (data[4]! >> 5) & 7
            bitstreamColor = {
                matrix: ({ 1: 'bt470bg', 2: 'bt709', 3: 'smpte170m' } as const)[space as 1 | 2 | 3],
                fullRange: !!(data[4]! & 16),
            }
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
                bitstreamColor,
                rawModelError,
                rawPatches,
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
        if (!pickedHandle)
            await root.removeEntry(name).catch((error: unknown) => {
                if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error
            })
    }
}
