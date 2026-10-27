import { configureHeldBgm, type HeldEnvironment } from '../../../src/editor/media/heldBgm'
import type { WorkerContext } from '../../../src/local/worker/handlers'
import { mediaHandlers } from '../../../src/local/worker/mediaHandlers'

// The media store as the page reads it (`readMedia`) on a test core, for the tests of a state that
// names audio it does not hold. The handler returns its bytes marked for transfer; a direct call
// sees the mark, and the page's end the bytes.

/** The bytes `readMedia` answers, as the page receives them. */
export const readMediaBytes = async (
    context: WorkerContext,
    hash: string,
): Promise<ArrayBuffer | undefined> => {
    const answer = await mediaHandlers(context).readMedia(hash)
    if (answer === undefined || answer instanceof ArrayBuffer) return answer
    return (answer as unknown as { value: ArrayBuffer }).value
}

/** A decoder that takes any bytes as one second of audio. */
export const fakeDecode: HeldEnvironment['decode'] = () =>
    Promise.resolve({ buffer: { duration: 1 } as AudioBuffer })

/** Starts the live watcher over a test core. */
export const watchMedia = (
    context: WorkerContext,
    run: <T>(work: () => Promise<T>) => Promise<T>,
    extra: Partial<HeldEnvironment> = {},
) =>
    configureHeldBgm({
        read: (hash) => run(() => readMediaBytes(context, hash)),
        decode: fakeDecode,
        ...extra,
    })
