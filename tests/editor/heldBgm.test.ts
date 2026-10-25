import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import {
    CACHE_ENTRIES,
    bgmStatus,
    cacheBgm,
    cacheHeld,
    cachedHashes,
    cachedHeld,
    claimNotice,
    configureHeldBgm,
    onUnheldAfterMove,
    resetHeldBgmForTests,
    settleHeldBgm,
    withCachedBgm,
    type HeldEnvironment,
    type HeldParts,
} from '../../src/editor/media/heldBgm'
import { createSessionDescriptor, session } from '../../src/history/session'
import {
    canUndo,
    liveState,
    peek,
    replaceState,
    resetStates,
    setSlotLoader,
} from '../../src/history/stack'
import type { State } from '../../src/state'
import type { Bgm } from '../../src/state/bgm'
import { initialStep } from '../helpers/historySteps'

// The BGMs this tab holds: one `Bgm` per hash in a small
// cache, the live watcher that attaches audio to a state that names it, and the notice rule.

const meta = (hash: string) => ({ hash, filename: `${hash}.mp3`, size: 4, type: 'audio/mpeg' })

const stateOf = (bgm: Bgm): State => ({ bgm, selectedEntities: [] }) as unknown as State

const named = (hash: string): State => stateOf({ offset: 0, meta: meta(hash) })

const parts = (tag: string): HeldParts => ({
    buffer: { tag } as unknown as AudioBuffer,
    source: new TextEncoder().encode(tag).buffer,
})

const deferred = <T>() => {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((done, fail) => {
        resolve = done
        reject = fail
    })
    return { promise, resolve, reject }
}

const bytes = (tag: string) => new TextEncoder().encode(tag).buffer

/** A new session showing a state: what a load or a switch does. */
const show = (state: State) => {
    session.value = createSessionDescriptor()
    resetStates({ isDirty: false, step: initialStep(), state })
}

const environment = (extra: Partial<HeldEnvironment> = {}) => {
    const reads: string[] = []
    const decodes: ArrayBuffer[] = []
    const env: HeldEnvironment = {
        read: (hash) => {
            reads.push(hash)
            return Promise.resolve(bytes(hash))
        },
        decode: (data) => {
            decodes.push(data)
            return Promise.resolve({
                buffer: { decoded: data.byteLength } as unknown as AudioBuffer,
            })
        },
        ...extra,
    }
    return { env, reads, decodes }
}

const said: string[] = []

beforeEach(() => {
    resetHeldBgmForTests()
    said.length = 0
    onUnheldAfterMove((hash) => said.push(hash))
    setSlotLoader(undefined)
    show(named('a'))
})

test('the cache keeps three hashes, drops the least recently used, and never the live head’s', () => {
    show(named('a'))
    cacheHeld('a', parts('a'))
    cacheHeld('b', parts('b'))
    cacheHeld('c', parts('c'))
    assert.equal(CACHE_ENTRIES, 3)
    // Reading `b` makes `a` the oldest, but `a` is the live head's.
    cachedHeld('b')
    cacheHeld('d', parts('d'))
    assert.deepEqual(cachedHashes().sort(), ['a', 'b', 'd'])
    show(named('z'))
    // A new session starts with nothing: its waveforms are its own.
    assert.deepEqual(cachedHashes(), [])
})

test('a slot is built with the audio the cache holds for its hash, keeping its meta', () => {
    const held = parts('a')
    cacheHeld('a', held)
    const state = named('a')
    const attached = withCachedBgm(state)
    assert.equal(attached.bgm.buffer, held.buffer)
    assert.equal(attached.bgm.source, held.source)
    // The same meta object: the slot keeps its stored root and the file state.
    assert.equal(attached.bgm.meta, state.bgm.meta)
    // Another hash, a state with audio already, and a state with none: untouched.
    assert.equal(withCachedBgm(named('b')).bgm.buffer, undefined)
    const loaded = stateOf({ offset: 0, meta: meta('a'), buffer: {} as AudioBuffer })
    assert.equal(withCachedBgm(loaded), loaded)
    const none = stateOf({ offset: 0 })
    assert.equal(withCachedBgm(none), none)
})

test('a loaded BGM is cached under its hash, and only a whole one', () => {
    cacheBgm({ offset: 0, meta: meta('a') })
    cacheBgm({ offset: 0, meta: meta('b'), buffer: {} as AudioBuffer })
    assert.deepEqual(cachedHashes(), [])
    const held = parts('c')
    cacheBgm({ offset: 0, meta: meta('c'), buffer: held.buffer, source: held.source })
    assert.deepEqual(cachedHashes(), ['c'])
})

test('a notice is for the first asker per hash, and the next session starts afresh', () => {
    assert.equal(claimNotice('a'), true)
    assert.equal(claimNotice('a'), false)
    assert.equal(claimNotice('b'), true)
    show(named('a'))
    assert.equal(claimNotice('a'), true)
})

test('the watcher attaches a cached BGM at once, as no step', async () => {
    const held = parts('a')
    cacheHeld('a', held)
    const { env, reads } = environment()
    configureHeldBgm(env)
    await settleHeldBgm()
    assert.equal(liveState.value.bgm.buffer, held.buffer)
    assert.equal(liveState.value.bgm.source, held.source)
    assert.deepEqual(reads, [])
    assert.equal(canUndo.value, false)
})

test('the watcher reads the media store once however often it is asked, and attaches the decoded audio', async () => {
    const { env, reads, decodes } = environment()
    configureHeldBgm(env)
    const before = liveState.value.bgm.meta
    // A second ask while the first is under way shares its read.
    assert.equal(await bgmStatus('a', 4), 'held')
    await settleHeldBgm()
    assert.deepEqual(reads, ['a'])
    assert.equal(decodes.length, 1)
    assert.ok(liveState.value.bgm.buffer)
    assert.deepEqual(
        new Uint8Array(liveState.value.bgm.source ?? new ArrayBuffer(0)),
        new Uint8Array(bytes('a')),
    )
    assert.equal(liveState.value.bgm.meta, before)
    assert.deepEqual(cachedHashes(), ['a'])
})

test('no surface calls a BGM unheld while its bytes are decoding', async () => {
    const decoding = deferred<{ buffer: AudioBuffer }>()
    const { env } = environment({ decode: () => decoding.promise })
    configureHeldBgm(env)
    assert.equal(await bgmStatus('a', 4), 'held')
    assert.equal(liveState.value.bgm.buffer, undefined)
    decoding.resolve({ buffer: {} as AudioBuffer })
    await settleHeldBgm()
    assert.ok(liveState.value.bgm.buffer)
})

test('audio is never attached under another session, another hash or a peek', async () => {
    const read = deferred<ArrayBuffer>()
    const { env } = environment({
        read: (hash) => (hash === 'a' ? read.promise : Promise.resolve(undefined)),
    })
    configureHeldBgm(env)
    // The tab moved on to another session while the store was read.
    show(named('b'))
    const other = liveState.value
    read.resolve(bytes('a'))
    await settleHeldBgm()
    assert.equal(liveState.value, other)
    assert.equal(liveState.value.bgm.buffer, undefined)
    // The result is not kept for a session that is gone.
    assert.deepEqual(cachedHashes(), [])
})

test('a peek keeps its own state, and the live one gets the audio when the peek ends', async () => {
    const read = deferred<ArrayBuffer>()
    const { env } = environment({ read: () => read.promise })
    configureHeldBgm(env)
    const peeked = named('a')
    peek.value = { source: {}, state: peeked }
    read.resolve(bytes('a'))
    await settleHeldBgm()
    assert.equal(peek.value.state, peeked)
    assert.equal(liveState.value.bgm.buffer, undefined)
    peek.value = undefined
    await settleHeldBgm()
    assert.ok(liveState.value.bgm.buffer)
})

test('Undo or Redo to a BGM nothing holds says so once per hash; a load, a switch or a repeat does not', async () => {
    const { env } = environment({ read: () => Promise.resolve(undefined) })
    configureHeldBgm(env)
    await settleHeldBgm()
    // Arriving in a session is the load's or the switch's to say.
    assert.deepEqual(said, [])
    const first = liveState.value
    replaceState({ ...first, bgm: { offset: 0, meta: meta('b') } })
    await settleHeldBgm()
    assert.deepEqual(said, ['b'])
    replaceState(first)
    await settleHeldBgm()
    replaceState({ ...first, bgm: { offset: 0, meta: meta('b') } })
    await settleHeldBgm()
    // `a` was not said at arrival, so the move back to it says it; `b` is not repeated.
    assert.deepEqual(said, ['b', 'a'])
})

test('a read that fails says nothing and is tried again at the next change', async () => {
    let attempts = 0
    const { env } = environment({
        read: (hash) => {
            attempts++
            return attempts === 1
                ? Promise.reject(new Error('could not read'))
                : Promise.resolve(bytes(hash))
        },
    })
    configureHeldBgm(env)
    await settleHeldBgm()
    assert.equal(attempts, 1)
    assert.deepEqual(said, [])
    assert.equal(liveState.value.bgm.buffer, undefined)
    // A failed read is not "absent": the next state naming the BGM asks again.
    const live = liveState.value
    replaceState({ ...live, bgm: { ...live.bgm } })
    await settleHeldBgm()
    assert.equal(attempts, 2)
    assert.ok(liveState.value.bgm.buffer)
    assert.deepEqual(said, [])
})
