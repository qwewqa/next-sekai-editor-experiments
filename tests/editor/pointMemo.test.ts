import assert from 'node:assert/strict'
import test from 'node:test'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { shallowRef } from 'vue'
import { createPointMemo } from '../../src/editor/tools/pointMemo'

// The hover and the cursor share one point-hit answer per frame. The answer must not outlive the
// state it was found in: an old state holds its BGM's decoded audio.

test('an answer is reused for the same key, and found again once the state changes', () => {
    const state = shallowRef({})
    const memo = createPointMemo<string[]>(state)
    let finds = 0
    const find = () => [`hits ${++finds}`]
    const first = memo([1, 2], find)
    assert.equal(memo([1, 2], find), first)
    memo([1, 3], find)
    assert.equal(finds, 2)
    // A new state drops the answer, even for a key that leaves the state out.
    state.value = {}
    memo([1, 3], find)
    assert.equal(finds, 3)
})

test('the memo does not keep the state it was found in once the state changes', async () => {
    setFlagsFromString('--expose-gc')
    const gc = runInNewContext('gc') as () => void
    const state = shallowRef<object>({})
    const memo = createPointMemo<object>(state)
    const show = () => {
        const shown = {}
        state.value = shown
        memo([shown], () => ({}))
        return new WeakRef(shown)
    }
    const left = show()
    state.value = {}
    await new Promise((resolve) => setTimeout(resolve, 0))
    gc()
    assert.equal(left.deref(), undefined)
})
