import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import { bgmInput } from '../../src/editor/headerLabelText'
import type { bgmOperation } from '../../src/editor/headerLabels'
import { applyPick, decidePick, type PickedBgm } from '../../src/editor/media/applyPick'
import {
    cachedHashes,
    configureHeldBgm,
    heldOrDecoded,
    resetHeldBgmForTests,
    settleHeldBgm,
} from '../../src/editor/media/heldBgm'
import { createSessionDescriptor, session } from '../../src/history/session'
import {
    canUndo,
    liveState,
    loadedStates,
    resetStates,
    setSlotLoader,
    undoState,
} from '../../src/history/stack'
import type { State } from '../../src/state'
import type { Bgm } from '../../src/state/bgm'
import { emptyStore } from '../helpers/emptyStore'
import { initialStep, nativeOperation } from '../helpers/historySteps'

const operation = ((old, next) =>
    nativeOperation(bgmInput(old, next), 'Changed BGM file')) as typeof bgmOperation

// Choose Audio…'s decision: the file the state names is attached and stored
// again as no step, with the recorded meta kept; any other file is one BGM change.

const meta = (hash: string, filename = `${hash}.mp3`) => ({
    hash,
    filename,
    size: 4,
    type: 'audio/mpeg',
})

const stateOf = (bgm: Bgm): State =>
    ({ bgm, selectedEntities: [], store: emptyStore }) as unknown as State

const picked = (hash: string, filename = `${hash}.mp3`): PickedBgm => ({
    filename: filename.replace(/\.mp3$/, ''),
    buffer: { picked: hash } as unknown as AudioBuffer,
    source: new TextEncoder().encode(hash).buffer,
    meta: meta(hash, filename),
})

const show = (bgm: Bgm) => {
    session.value = createSessionDescriptor()
    resetStates({ isDirty: false, step: initialStep(), state: stateOf(bgm) })
}

const stored: { hash: string; bytes: number; type: string; kind: string }[] = []

beforeEach(async () => {
    resetHeldBgmForTests()
    setSlotLoader(undefined)
    stored.length = 0
    show({ offset: 0 })
    configureHeldBgm({
        read: () => Promise.resolve(undefined),
        decode: () => Promise.reject(new Error('unused')),
        store: (item) => {
            stored.push({
                hash: item.hash,
                bytes: item.bytes.byteLength,
                type: item.type,
                kind: item.kind,
            })
            return Promise.resolve(true)
        },
    })
    await settleHeldBgm()
})

test('the decision is made on the hash alone', () => {
    const unloaded: Bgm = { offset: 0, meta: meta('a', 'a.mp3') }
    assert.deepEqual(decidePick(unloaded, { hash: 'a' }), { kind: 'attach' })
    assert.deepEqual(decidePick({ ...unloaded, buffer: {} as AudioBuffer }, { hash: 'a' }), {
        kind: 'loaded',
    })
    assert.deepEqual(decidePick(unloaded, { hash: 'b' }), {
        kind: 'change',
        named: true,
        original: 'a.mp3',
    })
    assert.deepEqual(
        decidePick({ offset: 0, meta: { ...meta('a'), filename: '' } }, { hash: 'b' }),
        {
            kind: 'change',
            named: true,
        },
    )
    // A BGM that is loaded, or none, is changed as any pick changes it.
    assert.deepEqual(decidePick({ ...unloaded, buffer: {} as AudioBuffer }, { hash: 'b' }), {
        kind: 'change',
        named: false,
    })
    assert.deepEqual(decidePick({ offset: 0 }, { hash: 'b' }), { kind: 'change', named: false })
})

test('the file the state names is attached and stored again, as no step, keeping its meta and name', async () => {
    const original = meta('a', 'coconut.mp3')
    show({ offset: 0.25, filename: 'Coconut mix', meta: original })
    const file = picked('a', 'renamed copy.mp3')
    assert.deepEqual(applyPick(file, session.value.sessionId, operation), { kind: 'attached' })
    const bgm = liveState.value.bgm
    assert.equal(bgm.buffer, file.buffer)
    assert.equal(bgm.source, file.source)
    // The recorded name and meta stay those of the original; the offset is untouched.
    assert.equal(bgm.meta, original)
    assert.equal(bgm.filename, 'Coconut mix')
    assert.equal(bgm.offset, 0.25)
    assert.equal(canUndo.value, false)
    assert.deepEqual(stored, [{ hash: 'a', bytes: 1, type: 'audio/mpeg', kind: 'bgm' }])
    assert.deepEqual(cachedHashes(), ['a'])
})

test('another file is one BGM change, saying that it differs from the original', () => {
    show({ offset: 0.25, filename: 'Coconut', meta: meta('a', 'coconut.mp3') })
    const file = picked('b', 'melt.mp3')
    const outcome = applyPick(file, session.value.sessionId, operation)
    // The caller says so, naming the original file.
    assert.deepEqual(outcome, {
        kind: 'changed',
        decision: { kind: 'change', named: true, original: 'coconut.mp3' },
        text: 'Changed BGM file',
    })
    const bgm = liveState.value.bgm
    assert.equal(bgm.buffer, file.buffer)
    assert.equal(bgm.meta?.hash, 'b')
    assert.equal(bgm.filename, 'melt')
    // The offset does not change.
    assert.equal(bgm.offset, 0.25)
    assert.equal(canUndo.value, true)
    assert.deepEqual(stored, [])
})

test('a BGM that already has its audio is changed as usual, without the differs line', () => {
    show({
        offset: 0,
        filename: 'Coconut',
        meta: meta('a'),
        buffer: { tag: 'a' } as unknown as AudioBuffer,
    })
    const outcome = applyPick(picked('b'), session.value.sessionId, operation)
    assert.equal(liveState.value.bgm.meta?.hash, 'b')
    assert.equal(canUndo.value, true)
    assert.equal(outcome.kind === 'changed' && outcome.decision.named, false)
})

test('a file for a BGM that is loaded already changes nothing', () => {
    const buffer = { tag: 'a' } as unknown as AudioBuffer
    show({ offset: 0, meta: meta('a'), buffer })
    const outcome = applyPick(picked('a'), session.value.sessionId, operation)
    assert.deepEqual(outcome, { kind: 'unchanged' })
    assert.equal(liveState.value.bgm.buffer, buffer)
    assert.equal(canUndo.value, false)
    assert.deepEqual(stored, [])
})

test('undo slots keep decoded audio only while the cache holds it, and get it back from their bytes', async () => {
    const decodes: string[] = []
    configureHeldBgm({
        // The store lacks every file: what a slot gets back comes from the bytes it kept.
        read: () => Promise.resolve(undefined),
        decode: (data) => {
            const hash = new TextDecoder().decode(data)
            decodes.push(hash)
            return Promise.resolve({ buffer: { decoded: hash } as unknown as AudioBuffer })
        },
    })
    const hashes = ['a', 'b', 'c', 'd', 'e']
    for (const hash of hashes) applyPick(picked(hash), session.value.sessionId, operation)
    await settleHeldBgm()
    const held = loadedStates().flatMap(({ state }) =>
        state.bgm.buffer ? [state.bgm.meta?.hash] : [],
    )
    assert.deepEqual([...new Set(held)].sort(), ['c', 'd', 'e'])
    // Every slot still names its BGM and keeps its bytes.
    assert.deepEqual(
        loadedStates().map(({ state }) => [state.bgm.meta?.hash, !!state.bgm.source]),
        [[undefined, false], ...hashes.map((hash) => [hash, true])],
    )
    for (let i = 0; i < 4; i++) {
        undoState()
        await settleHeldBgm()
    }
    assert.equal(liveState.value.bgm.meta?.hash, 'a')
    assert.deepEqual(liveState.value.bgm.buffer, { decoded: 'a' })
    assert.deepEqual(decodes, ['b', 'a'])
})

test('a file picked again is held once: its audio and bytes are the ones the cache holds', async () => {
    const first = picked('a')
    applyPick(first, session.value.sessionId, operation)
    applyPick(picked('b'), session.value.sessionId, operation)
    let decodes = 0
    const decode = () => {
        decodes++
        return Promise.resolve({ decoded: decodes } as unknown as AudioBuffer)
    }
    const again = await heldOrDecoded('a', new TextEncoder().encode('a').buffer, decode)
    assert.equal(decodes, 0)
    assert.equal(again.buffer, first.buffer)
    assert.equal(again.source, first.source)
    applyPick({ ...picked('a'), ...again }, session.value.sessionId, operation)
    const named = loadedStates().filter(({ state }) => state.bgm.meta?.hash === 'a')
    assert.equal(named.length, 2)
    assert.equal(new Set(named.map(({ state }) => state.bgm.buffer)).size, 1)
    assert.equal(new Set(named.map(({ state }) => state.bgm.source)).size, 1)
    // A file the cache lacks is decoded, and keeps the bytes captured at its pick.
    const source = new TextEncoder().encode('z').buffer
    const fresh = await heldOrDecoded('z', source, decode)
    assert.equal(decodes, 1)
    assert.equal(fresh.source, source)
})

test('a file picked again after the cache let it go is decoded, with the bytes its undo slot kept', async () => {
    const first = picked('a')
    applyPick(first, session.value.sessionId, operation)
    for (const hash of ['b', 'c', 'd']) applyPick(picked(hash), session.value.sessionId, operation)
    assert.equal(cachedHashes().includes('a'), false)
    const decoded = { decoded: 'a' } as unknown as AudioBuffer
    const again = await heldOrDecoded('a', new TextEncoder().encode('a').buffer, () =>
        Promise.resolve(decoded),
    )
    assert.equal(again.buffer, decoded)
    assert.equal(again.source, first.source)
})
