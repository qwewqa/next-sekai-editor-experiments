import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import { bgmInput } from '../../src/editor/headerLabelText'
import type { bgmOperation } from '../../src/editor/headerLabels'
import { applyPick, decidePick, type PickedBgm } from '../../src/editor/media/applyPick'
import {
    cachedHashes,
    configureHeldBgm,
    resetHeldBgmForTests,
    settleHeldBgm,
} from '../../src/editor/media/heldBgm'
import { createSessionDescriptor, session } from '../../src/history/session'
import { canUndo, liveState, resetStates, setSlotLoader } from '../../src/history/stack'
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
