import assert from 'node:assert/strict'
import test from 'node:test'
import { BGM_MAX_SECONDS, decodeWithinLimit } from '../../src/utils/bgmLimit'
import { TaskFailure } from '../../src/utils/error'
import { utf8, wav } from '../preview/files/fixtures'

// The BGM length limit: a bound over it refuses before the decoder, the exact duration refuses
// after, and each says so in its own words.

const spy = (duration: number) => {
    const calls: number[] = []
    const decode = (data: ArrayBuffer) => {
        calls.push(data.byteLength)
        return Promise.resolve({ duration } as AudioBuffer)
    }
    return { calls, decode }
}

const kindOf = async (work: Promise<unknown>) => {
    try {
        await work
    } catch (error) {
        if (error instanceof TaskFailure) return error.kind
        throw error
    }
}

test('audio under the limit decodes', async () => {
    const { calls, decode } = spy(60)
    const data = wav(60).buffer
    assert.equal((await decodeWithinLimit(data, decode)).duration, 60)
    assert.equal(calls.length, 1)
})

test('a bound over the limit refuses before the decoder, with the estimate kind', async () => {
    const { calls, decode } = spy(1)
    const data = wav(BGM_MAX_SECONDS + 1).buffer
    assert.equal(await kindOf(decodeWithinLimit(data, decode)), 'audioMayBeTooLong')
    assert.equal(calls.length, 0)
})

test('a container with no bound decodes, and its exact duration over the limit refuses after', async () => {
    const { calls, decode } = spy(BGM_MAX_SECONDS + 1)
    // Plain bytes have no measurable length, as a WebM or AIFF file has none.
    const data = utf8('not a container the reader knows, long enough to pass').buffer
    assert.equal(await kindOf(decodeWithinLimit(data as ArrayBuffer, decode)), 'audioTooLong')
    assert.equal(calls.length, 1)
})

test('a trailing chunk that pushes the bound over the limit refuses with the estimate kind', async () => {
    // One minute of audio, then 90 minutes of other bytes: the bound counts every byte after data.
    const audio = wav(60)
    const trailing = new Uint8Array(BGM_MAX_SECONDS * 8000)
    const bytes = new Uint8Array(audio.length + trailing.length)
    bytes.set(audio)
    const { calls, decode } = spy(60)
    assert.equal(await kindOf(decodeWithinLimit(bytes.buffer, decode)), 'audioMayBeTooLong')
    assert.equal(calls.length, 0)
})

test('a file the decoder refuses is an unreadable file', async () => {
    const data = wav(1).buffer
    const decode = () => Promise.reject(new Error('Unable to decode audio data'))
    assert.equal(await kindOf(decodeWithinLimit(data, decode)), 'audioUnreadable')
})
