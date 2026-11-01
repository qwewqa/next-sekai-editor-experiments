import { exportError } from '../error'
import { AUDIO_RATE } from '../timing'
import type { MuxInput } from './encode'

export type Track = 'video' | 'audio'
export type LoopStats = {
    queued: number
    submitted: Record<Track, number>
    written: Record<Track, number>
    submittedEnd: Record<Track, number>
    /** Video frames and seconds of playable audio, including work held inside the codecs. */
    readonly inFlight: Record<Track, number>
}

/** Waits on input consumption and writes, never on an encoder producing output. */
export const createFrameLoop = (options: {
    signal: AbortSignal
    audio: boolean
    queueSize: (track: Track) => number
    write: (input: MuxInput) => Promise<void>
}) => {
    const stats: LoopStats = {
        queued: 0,
        submitted: { video: 0, audio: 0 },
        written: { video: 0, audio: 0 },
        submittedEnd: { video: 0, audio: 0 },
        get inFlight() {
            return {
                video: stats.submitted.video - stats.written.video,
                audio: stats.submitted.audio - stats.written.audio,
            }
        },
    }
    const done = { video: false, audio: !options.audio }
    const queue: MuxInput[] = []
    const waiters = new Set<() => void>()
    let draining = false
    let failure: unknown
    let audioTrim: { startSamples: number; playableSamples: number } | undefined
    const wake = () => {
        for (const check of [...waiters]) check()
    }
    const fail = (error: unknown) => {
        failure ??= exportError(error)
        wake()
    }
    const aborted = () => {
        fail(options.signal.reason)
    }
    options.signal.addEventListener('abort', aborted, { once: true })
    if (options.signal.aborted) aborted()
    const wait = (ready: () => boolean): Promise<void> =>
        new Promise((resolve, reject) => {
            const check = () => {
                if (failure !== undefined) {
                    waiters.delete(check)
                    reject(exportError(failure))
                } else if (ready()) {
                    waiters.delete(check)
                    resolve()
                }
            }
            waiters.add(check)
            check()
        })
    const guard = <T>(operation: Promise<T>, late?: (value: T) => void): Promise<T> =>
        new Promise((resolve, reject) => {
            const check = () => {
                if (failure !== undefined) {
                    waiters.delete(check)
                    reject(exportError(failure))
                }
            }
            waiters.add(check)
            check()
            void operation.then(
                (value) => {
                    waiters.delete(check)
                    if (failure !== undefined) {
                        late?.(value)
                        reject(exportError(failure))
                    } else resolve(value)
                },
                (error: unknown) => {
                    waiters.delete(check)
                    fail(error)
                    reject(exportError(error))
                },
            )
        })
    const drain = async () => {
        if (draining || failure !== undefined) return
        draining = true
        try {
            while (queue.length) {
                const input = queue[0]
                if (!input) break
                await guard(options.write(input))
                queue.shift()
                stats.queued--
                if (input.track === 'video') stats.written.video++
                else if (input.track === 'audio') {
                    audioTrim ??= input.timing
                    if (!audioTrim) throw new Error('Audio timing is missing')
                    const endSample = Math.round(
                        ((input.packet.timestamp + input.packet.duration) * AUDIO_RATE) / 1e6,
                    )
                    stats.written.audio =
                        Math.max(0, Math.min(audioTrim.playableSamples, endSample)) / AUDIO_RATE
                }
                wake()
            }
        } catch (error) {
            fail(error)
        } finally {
            draining = false
            wake()
        }
    }
    return {
        stats,
        wake,
        fail,
        guard,
        room: (track: Track, end: number) =>
            wait(() => {
                const other = track === 'video' ? 'audio' : 'video'
                return (
                    options.queueSize(track) <= 2 &&
                    stats.queued <= 32 &&
                    (done[other] || end <= stats.submittedEnd[other] + 1 + 1e-9)
                )
            }),
        submitted(track: Track, end: number) {
            stats.submitted[track] = track === 'video' ? stats.submitted.video + 1 : end
            stats.submittedEnd[track] = end
            wake()
        },
        complete(track: Track) {
            done[track] = true
            wake()
        },
        audioFed: () => wait(() => done.audio),
        emit(input: MuxInput) {
            if (failure !== undefined) return
            queue.push(input)
            stats.queued++
            wake()
            void drain()
        },
        drained: () => wait(() => !stats.queued && !draining),
        dispose() {
            fail(new DOMException('Frame loop closed', 'AbortError'))
            options.signal.removeEventListener('abort', aborted)
            queue.length = 0
        },
    }
}
