import assert from 'node:assert/strict'
import test from 'node:test'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { rememberRoots } from '../../src/local/peekSource'
import type { State } from '../../src/state'
import { emptyStore } from '../helpers/emptyStore'

// The roots remembered for peeking are matched by their parts; they must not keep a BGM's decoded
// audio, which the undo stack lets go once the cache does.

test('a remembered root does not keep the decoded audio of the state it was flushed as', async () => {
    setFlagsFromString('--expose-gc')
    const gc = runInNewContext('gc') as () => void
    const store = { ...emptyStore }
    const remember = () => {
        const buffer = { audio: new Float32Array(1 << 16) }
        const state = {
            bgm: { offset: 0, buffer, meta: { hash: 'a', filename: 'a', size: 1, type: '' } },
            selectedEntities: [],
            store,
        } as unknown as State
        rememberRoots([[state, new Uint8Array(16)]])
        return new WeakRef(buffer)
    }
    const audio = remember()
    await new Promise((resolve) => setTimeout(resolve, 0))
    gc()
    assert.equal(audio.deref(), undefined)
    // The store, and with it what is remembered for it, is still alive.
    assert.ok(store)
})
