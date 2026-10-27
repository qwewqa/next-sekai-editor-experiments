import { nextTick, watch } from 'vue'
import { recordError } from '../../diagnostics'
import { session } from '../../history/session'
import { isPeeking, liveState, replaceState } from '../../history/stack'
import type { BatchMedia } from '../../local/flushWrite'
import type { StorageWorker } from '../../local/worker/client'
import type { State } from '../../state'
import type { Bgm } from '../../state/bgm'
import { TaskFailure } from '../../utils/error'
import { releaseWaveform, type Waveform } from '../../waveform'
import type { NoticeLine } from '../notification'

// The BGMs this tab holds, one `Bgm` per hash. A state read from storage names its audio by hash
// and holds none; this brings the bytes back from memory or the media store, and attaches them to
// the live state without a step, a new root or a change of the file state. A BGM is "held" when
// this tab has its bytes or the media store does, and only a BGM neither holds is "not loaded".

/** Decoded audio with the original bytes, shared by every state naming its hash. */
export type HeldParts = { buffer: AudioBuffer; waveform?: Waveform; source: ArrayBuffer }

export type HeldEnvironment = {
    /** The stored bytes, whole, or undefined when the store lacks them. Rejects when it could not look. */
    read: (hash: string, size: number | undefined) => Promise<ArrayBuffer | undefined>
    /** Decodes bytes and builds their waveform. The bytes are detached by it. */
    decode: (data: ArrayBuffer) => Promise<{ buffer: AudioBuffer; waveform?: Waveform }>
    /** Stores a picked item again (`storeMedia`). */
    store?: (item: BatchMedia) => Promise<boolean>
    /** Whether the startup gate is still open: a reattachment that begins then is startup's. */
    atStartup?: () => boolean
}

/** Entries kept besides none that is the live head's. */
export const CACHE_ENTRIES = 3

const cache = new Map<string, HeldParts>()
const told = new Set<string>()
/** The hashes refused for their length in this session, with why: never decoded again. */
const refused = new Map<string, BgmRefusal>()
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

/** Why a BGM was refused for its length: the container's bound, or the decoded duration. */
export type BgmRefusal = 'audioMayBeTooLong' | 'audioTooLong'

let refusedNotice: ((hash: string, kind: BgmRefusal, startup: boolean) => void) | undefined

/**
 * What says so when a BGM that is not picked now is refused for its length (the editor side
 * registers it). `startup` is true when the reattachment that found it began while the startup
 * gate was open, so the refusal may arrive long after.
 */
export const onBgmRefused = (say: (hash: string, kind: BgmRefusal, startup: boolean) => void) => {
    refusedNotice = say
}

/** The refusal an error carries, if it is one. */
export const refusalOf = (error: unknown): BgmRefusal | undefined =>
    error instanceof TaskFailure &&
    (error.kind === 'audioMayBeTooLong' || error.kind === 'audioTooLong')
        ? error.kind
        : undefined

type Waiting = { id: string; hash: string; kind: BgmRefusal; startup: boolean }

let holds = 0
const waiting: Waiting[] = []
/** The refusal said for the session shown: a card raised later carries it as a row. */
let known: { id: string; kind: BgmRefusal } | undefined
/** A card that can take a refusal as a row while it shows (an open's, a damage warning). */
let rowCard: { id: string; shown: () => boolean; raise: () => void } | undefined

let refusalLineOf: ((kind: BgmRefusal) => NoticeLine) | undefined

/** How a refusal reads as a row of a card (the editor side registers it). */
export const onRefusalLine = (build: (kind: BgmRefusal) => NoticeLine) => {
    refusalLineOf = build
}

/** The row for the refusal said for the session now shown, if any. */
export const knownRefusalLine = (): NoticeLine | undefined => {
    const kind = knownRefusal()
    return kind ? refusalLineOf?.(kind) : undefined
}

/** The refusal said for the session now shown, if any. */
export const knownRefusal = (): BgmRefusal | undefined =>
    known?.id === session.value.sessionId ? known.kind : undefined

/**
 * Registers the card just raised for the session shown: while `shown` holds, a refusal that
 * comes later is added to it by `raise` (which composes the card again with `knownRefusal`),
 * instead of a card of its own replacing it.
 */
export const hostRefusalRow = (host: { shown: () => boolean; raise: () => void }) => {
    rowCard = { id: session.value.sessionId, ...host }
}

const sayRefusal = ({ id, hash, kind, startup }: Waiting) => {
    if (session.value.sessionId !== id) return
    if (rowCard?.id === id && rowCard.shown()) {
        rowCard.raise()
        return
    }
    refusedNotice?.(hash, kind, startup)
}

/**
 * Keeps refusal cards back while an open composes its own notice, which a later card would
 * replace. `claimRefusal` takes the refusal of the session now shown out of the queue and
 * returns it, to add as a row of the open's card; `release` says any that is left, as a card of
 * its own. A refusal of another session is dropped.
 */
export const holdRefusalNotices = () => {
    holds++
    let released = false
    return {
        claimRefusal: (): BgmRefusal | undefined => {
            const id = session.value.sessionId
            for (let at = waiting.findIndex((entry) => entry.id === id); at !== -1;)
                at = (waiting.splice(at, 1), waiting.findIndex((entry) => entry.id === id))
            return knownRefusal()
        },
        release: () => {
            if (released) return
            released = true
            if (--holds === 0) for (const entry of waiting.splice(0)) sayRefusal(entry)
        },
    }
}

/** Says a refusal once per hash per session, for the session shown. */
const announceRefusal = (hash: string, kind: BgmRefusal, startup: boolean) => {
    if (!claimNotice(hash)) return
    const entry = { id: session.value.sessionId, hash, kind, startup }
    known = { id: entry.id, kind }
    if (holds) waiting.push(entry)
    else sayRefusal(entry)
}

/** Remembers a refusal for the session and says it once. Returns whether the error was one. */
export const noticeRefused = (hash: string, error: unknown, startup = false) => {
    const kind = refusalOf(error)
    if (!kind) return false
    refused.set(hash, kind)
    announceRefusal(hash, kind, startup)
    return true
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
            // A hash refused for its length is never decoded again; its status stays as read.
            if (result.kind !== 'bytes' || !env || refused.has(hash)) return
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
                // A refusal for length is remembered for the session that began the decode, and
                // passed up to the caller that says it.
                const kind = refusalOf(error)
                if (kind) {
                    if (session.value.sessionId === started) refused.set(hash, kind)
                    throw error
                }
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

const reattach = async (id: string, bgm: Bgm, moved: boolean, startup: boolean) => {
    const meta = bgm.meta
    if (!meta) return
    const why = refused.get(meta.hash)
    if (why) {
        // Back at refused audio whose notice was not said while it was away.
        if (session.value.sessionId === id && liveState.value.bgm.meta?.hash === meta.hash)
            announceRefusal(meta.hash, why, startup)
        return
    }
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
    let parts: HeldParts | undefined
    try {
        parts = await fetch.parts
    } catch (error) {
        // Said for the session shown, where the hash is still the live one.
        if (session.value.sessionId === id && liveState.value.bgm.meta?.hash === meta.hash)
            noticeRefused(meta.hash, error, startup)
        return
    }
    if (parts) attachHeld(id, meta.hash, parts)
}

const onLive = (id: string, bgm: Bgm, peeking: boolean) => {
    const arrived = id !== lastSession
    const moved = !arrived && bgm !== lastBgm
    lastSession = id
    lastBgm = bgm
    if (peeking || !bgm.meta || bgm.buffer) return
    runHeld(reattach(id, bgm, moved, environment?.atStartup?.() ?? false))
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
    refused.clear()
    known = undefined
    rowCard = undefined
    fetching.clear()
    holds = 0
    waiting.length = 0
    lastSession = undefined
    lastBgm = undefined
}

// A new session has its own waveforms (the reset revokes every one), so nothing carries over.
watch(
    () => session.value.sessionId,
    () => {
        cache.clear()
        told.clear()
        refused.clear()
        known = undefined
        rowCard = undefined
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
