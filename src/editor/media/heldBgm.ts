import { nextTick, watch } from 'vue'
import { recordError } from '../../diagnostics'
import { session } from '../../history/session'
import { isPeeking, liveState, replaceState } from '../../history/stack'
import type { BatchMedia } from '../../local/flushWrite'
import type { StorageWorker } from '../../local/worker/client'
import type { State } from '../../state'
import type { Bgm } from '../../state/bgm'
import { releaseWaveform, type Waveform } from '../../waveform'

// The BGMs this tab holds, one `Bgm` per hash (Part 1 §1.6.8.4, as amended by the Step 7 design
// §3.6). A state read from storage names its audio by hash and holds none; this brings the bytes
// back from memory or the media store, and attaches them to the live state without a step, a new
// root or a change of the file state. A BGM is "held" when this tab has its bytes or the media
// store does, and only a BGM neither holds is "not loaded".

/** Decoded audio with the original bytes, shared by every state naming its hash. */
export type HeldParts = { buffer: AudioBuffer; waveform?: Waveform; source: ArrayBuffer }

export type HeldEnvironment = {
    /** The stored bytes, whole, or undefined when the store lacks them. Rejects when it could not look. */
    read: (hash: string, size: number | undefined) => Promise<ArrayBuffer | undefined>
    /** Decodes bytes and builds their waveform. The bytes are detached by it. */
    decode: (data: ArrayBuffer) => Promise<{ buffer: AudioBuffer; waveform?: Waveform }>
    /** Stores a picked item again (`storeMedia`). */
    store?: (item: BatchMedia) => Promise<boolean>
}

/** Entries kept besides none that is the live head's. */
export const CACHE_ENTRIES = 3

const cache = new Map<string, HeldParts>()
const told = new Set<string>()
/** The reads in flight, by hash: one read and decode however many places ask. */
const fetching = new Map<string, Fetch>()

/** The work running now (reads, decodes, notices): what a test waits for instead of a delay. */
const running = new Set<Promise<unknown>>()

/** Runs work that nothing else awaits, so `settleHeldBgm` can wait for it. */
export const runHeld = (work: Promise<unknown>) => {
    const tracked = work.catch(recordError).finally(() => running.delete(tracked))
    running.add(tracked)
}

/** Resolves once every piece of work started so far, and what it started, has ended. */
export const settleHeldBgm = async () => {
    // The watcher runs on the next tick.
    await nextTick()
    while (running.size) {
        await Promise.all([...running])
        await nextTick()
    }
}

let environment: HeldEnvironment | undefined
let unheldNotice: ((hash: string) => void) | undefined

/** What says so when Undo or Redo reaches a BGM nothing holds (the editor side registers it). */
export const onUnheldAfterMove = (say: (hash: string) => void) => {
    unheldNotice = say
}

const liveHash = () => liveState.value.bgm.meta?.hash

/** Puts a hash's parts in the cache, the most recently used; the oldest goes, never the live head's. */
export const cacheHeld = (hash: string, parts: HeldParts) => {
    cache.delete(hash)
    cache.set(hash, parts)
    const live = liveHash()
    while (cache.size > CACHE_ENTRIES) {
        const oldest = [...cache.keys()].find((key) => key !== live)
        if (oldest === undefined) break
        cache.delete(oldest)
    }
}

export const cachedHeld = (hash: string) => {
    const parts = cache.get(hash)
    if (parts) {
        cache.delete(hash)
        cache.set(hash, parts)
    }
    return parts
}

/** The parts a loaded `Bgm` holds, when it holds all of them. */
export const partsOf = (bgm: Bgm): HeldParts | undefined =>
    bgm.buffer && bgm.source
        ? {
              buffer: bgm.buffer,
              source: bgm.source,
              ...(bgm.waveform ? { waveform: bgm.waveform } : {}),
          }
        : undefined

/** Remembers a loaded BGM (a pick, an opened file's) for the states that name its hash. */
export const cacheBgm = (bgm: Bgm) => {
    const parts = partsOf(bgm)
    if (bgm.meta && parts) cacheHeld(bgm.meta.hash, parts)
}

const withParts = (bgm: Bgm, parts: HeldParts): Bgm => ({
    ...bgm,
    buffer: parts.buffer,
    source: parts.source,
    ...(parts.waveform ? { waveform: parts.waveform } : {}),
})

/** A state with its BGM attached when the cache holds it: what a restored slot is built with. */
export const withCachedBgm = (state: State): State => {
    const { bgm } = state
    if (!bgm.meta || bgm.buffer) return state
    const parts = cachedHeld(bgm.meta.hash)
    return parts ? { ...state, bgm: withParts(bgm, parts) } : state
}

/**
 * Attaches parts to the live state, only while it still names `hash` without audio in the
 * session `id`, and no peek holds the screen. Nothing is pushed: the slot keeps its root.
 */
export const attachHeld = (id: string, hash: string, parts: HeldParts) => {
    const live = liveState.value
    if (
        session.value.sessionId !== id ||
        isPeeking.value ||
        live.bgm.meta?.hash !== hash ||
        live.bgm.buffer
    )
        return false
    replaceState({ ...live, bgm: withParts(live.bgm, parts) })
    return true
}

/** Whether this tab has the bytes of a BGM already. */
export const isHeldHere = (bgm: Bgm) =>
    !!bgm.buffer || !!bgm.source || (!!bgm.meta && cache.has(bgm.meta.hash))

/** Whether the media store holds a hash; `failed` when it could not be asked, which says nothing. */
export type StoredStatus = 'held' | 'absent' | 'failed'

/** One key read of the media store. */
export const storedStatus = async (
    worker: Pick<StorageWorker, 'call'>,
    hash: string,
): Promise<StoredStatus> => {
    try {
        return (await worker.call('mediaHeld', [hash])).includes(hash) ? 'held' : 'absent'
    } catch (error) {
        recordError(error)
        return 'failed'
    }
}

/**
 * Whether a notice about an unheld hash may be said now: once per hash per session (cleared when
 * the session changes). The first asker takes it.
 */
export const claimNotice = (hash: string) => {
    if (told.has(hash)) return false
    told.add(hash)
    return true
}

type Fetch = { stored: Promise<StoredStatus>; parts: Promise<HeldParts | undefined> }

type Read = { kind: 'bytes'; bytes: ArrayBuffer } | { kind: 'absent' } | { kind: 'failed' }

/** The stored bytes of a hash, read and decoded once; the result is cached while its session lasts. */
const fetchHeld = (hash: string, size: number | undefined): Fetch => {
    const known = fetching.get(hash)
    if (known) return known
    const env = environment
    const started = session.value.sessionId
    const read: Promise<Read> = env
        ? env.read(hash, size).then(
              (bytes): Read => (bytes ? { kind: 'bytes', bytes } : { kind: 'absent' }),
              (error: unknown): Read => {
                  recordError(error)
                  return { kind: 'failed' }
              },
          )
        : Promise.resolve({ kind: 'failed' })
    const fetch: Fetch = {
        stored: read.then((result) => (result.kind === 'bytes' ? 'held' : result.kind)),
        parts: read.then(async (result) => {
            if (result.kind !== 'bytes' || !env) return
            try {
                const source = result.bytes.slice(0)
                const decoded = await env.decode(result.bytes)
                const parts: HeldParts = {
                    ...decoded,
                    source,
                }
                // A session that changed meanwhile has cleaned up its waveforms.
                if (session.value.sessionId !== started) {
                    releaseWaveform(decoded.waveform)
                    return
                }
                cacheHeld(hash, parts)
                return parts
            } catch (error) {
                // A cancelled waveform is the session changing; anything else is recorded.
                if (!(error instanceof DOMException && error.name === 'AbortError'))
                    recordError(error)
            }
        }),
    }
    fetching.set(hash, fetch)
    const done = () => {
        if (fetching.get(hash) === fetch) fetching.delete(hash)
    }
    void fetch.parts.then(done, done)
    return fetch
}

/**
 * Whether a hash is held, asking the store through this tab's read when the cache does not have
 * it. `held` while the bytes are still being decoded, so nothing says "not loaded" meanwhile.
 */
export const bgmStatus = async (hash: string, size: number | undefined): Promise<StoredStatus> => {
    if (cache.has(hash)) return 'held'
    return fetchHeld(hash, size).stored
}

let lastSession: string | undefined
let lastBgm: Bgm | undefined

const reattach = async (id: string, bgm: Bgm, moved: boolean) => {
    const meta = bgm.meta
    if (!meta) return
    const cached = cachedHeld(meta.hash)
    if (cached) {
        attachHeld(id, meta.hash, cached)
        return
    }
    const fetch = fetchHeld(meta.hash, meta.size)
    const stored = await fetch.stored
    if (stored === 'absent') {
        const live = liveState.value.bgm
        // Undo or Redo reached audio nothing holds; a load, an open or a switch say so themselves.
        if (
            moved &&
            session.value.sessionId === id &&
            live.meta?.hash === meta.hash &&
            !live.buffer &&
            claimNotice(meta.hash)
        )
            unheldNotice?.(meta.hash)
        return
    }
    if (stored !== 'held') return
    const parts = await fetch.parts
    if (parts) attachHeld(id, meta.hash, parts)
}

const onLive = (id: string, bgm: Bgm, peeking: boolean) => {
    const arrived = id !== lastSession
    const moved = !arrived && bgm !== lastBgm
    lastSession = id
    lastBgm = bgm
    if (peeking || !bgm.meta || bgm.buffer) return
    runHeld(reattach(id, bgm, moved))
}

let stop: (() => void) | undefined

/**
 * Starts the live watcher: a live state (never a peek) that names audio and holds none gets it
 * from the cache or the media store, if either has it.
 */
export const configureHeldBgm = (next: HeldEnvironment) => {
    stop?.()
    environment = next
    lastSession = undefined
    lastBgm = undefined
    stop = watch(
        [() => session.value.sessionId, () => liveState.value.bgm, isPeeking],
        ([id, bgm, peeking]) => {
            onLive(id, bgm, peeking)
        },
        { immediate: true },
    )
    return stop
}

/** The environment's store call, for a pick that keeps its bytes (Choose Audio…). */
export const storeHeld = (item: BatchMedia) => environment?.store?.(item)

/** Clears everything, as a test needs between cases. */
export const resetHeldBgmForTests = () => {
    stop?.()
    stop = undefined
    environment = undefined
    cache.clear()
    told.clear()
    fetching.clear()
    lastSession = undefined
    lastBgm = undefined
}

// A new session has its own waveforms (the reset revokes every one), so nothing carries over.
watch(
    () => session.value.sessionId,
    () => {
        cache.clear()
        told.clear()
        fetching.clear()
    },
    { flush: 'sync' },
)

/** The live BGM's hash is the one entry the cache keeps; exposed for the tests. */
export const cachedHashes = () => [...cache.keys()]

/** Decodes bytes as Choose Audio… does, without its dialog: the environment's `decode` in the page. */
export const decodeBgmData = async (data: ArrayBuffer) => {
    const [{ loadBgm }, { settings }, { createWaveform }] = await Promise.all([
        import('../../player'),
        import('../../settings'),
        import('../../waveform'),
    ])
    const buffer = await loadBgm(data)
    const waveform = await createWaveform(buffer, settings.waveform)
    return { buffer, ...(waveform ? { waveform } : {}) }
}
