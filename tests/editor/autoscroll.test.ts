import assert from 'node:assert/strict'
import test from 'node:test'
import {
    DEAD_ZONE,
    autoscrollSpeed,
    idleAutoscroll,
    reduceAutoscroll,
    type AutoscrollEvent,
    type AutoscrollState,
} from '../../src/editor/autoscroll'

test('the speed is still in the dead zone, follows the offset, rises, and is capped', () => {
    const extent = 900
    for (const sign of [1, -1]) {
        for (let offset = 0; offset <= DEAD_ZONE; offset++)
            assert.equal(autoscrollSpeed(sign * offset, extent), 0)
        let previous = 0
        let capped = false
        for (let offset = DEAD_ZONE + 1; offset < 5000; offset += 7) {
            const speed = autoscrollSpeed(sign * offset, extent)
            assert.equal(Math.sign(speed), sign)
            const size = Math.abs(speed)
            assert.ok(size <= 6 * extent)
            assert.ok(capped ? size === previous : size > previous)
            if (size === 6 * extent) capped = true
            previous = size
        }
        assert.ok(capped)
    }
})

const run = (events: AutoscrollEvent[], from: AutoscrollState = idleAutoscroll) => {
    let state = from
    const consumed: boolean[] = []
    for (const event of events) {
        const result = reduceAutoscroll(state, event)
        state = result.state
        consumed.push(result.consume)
    }
    return { state, consumed }
}

const start: AutoscrollEvent = { type: 'start', buttons: 4 }
const middleUp: AutoscrollEvent = { type: 'up', button: 1, buttons: 0 }
const near: AutoscrollEvent = { type: 'move', button: -1, buttons: 4, dx: 5, dy: 3 }
const far: AutoscrollEvent = { type: 'move', button: -1, buttons: 4, dx: 0, dy: 40 }
const back: AutoscrollEvent = { type: 'move', button: -1, buttons: 4, dx: 0, dy: 1 }

test('a release inside the dead zone keeps the motion; one after leaving it ends it', () => {
    const click = run([start, near, middleUp])
    assert.equal(click.state.running, true)
    assert.deepEqual(click.consumed, [false, false, true])
    assert.equal(run([start, far, middleUp]).state.running, false)
    assert.equal(run([start, far, back, middleUp]).state.running, false)
    // A sideways-only move counts, even when sideways scrolling is off.
    assert.equal(
        run([start, { type: 'move', button: -1, buttons: 4, dx: 30, dy: 0 }, middleUp]).state
            .running,
        false,
    )
})

const click: AutoscrollEvent[] = [start, middleUp]

test('a press stops the motion and is consumed with its release and click', () => {
    const { state, consumed } = run([
        ...click,
        { type: 'down', button: 0, buttons: 1, primary: true },
        { type: 'down', button: 0, buttons: 1, primary: false },
        { type: 'up', button: 0, buttons: 0 },
        { type: 'up', button: 0, buttons: 0 },
        { type: 'click', button: 0 },
    ])
    assert.equal(state.running, false)
    assert.deepEqual(consumed.slice(2), [true, true, true, true, true])
    assert.deepEqual(state.held, [])
    assert.deepEqual(state.trailing, [])
    // The next press is unrelated.
    assert.equal(
        reduceAutoscroll(state, { type: 'down', button: 0, buttons: 1, primary: true }).consume,
        false,
    )
})

test('a press that starts after the motion ended is not owned', () => {
    const ended = run([start, far, middleUp]).state
    const result = reduceAutoscroll(ended, { type: 'down', button: 2, buttons: 2, primary: true })
    assert.equal(result.consume, false)
    assert.equal(result.state.running, false)
    assert.equal(reduceAutoscroll(idleAutoscroll, { type: 'click', button: 0 }).consume, false)
})

test('Escape stops and is consumed; the held middle stays owned until its release', () => {
    const { state, consumed } = run([start, far, { type: 'escape' }])
    assert.equal(state.running, false)
    assert.equal(consumed[2], true)
    const after = run([middleUp, { type: 'click', button: 1 }], state)
    assert.deepEqual(after.consumed, [true, true])
})

test('another key stops without being consumed, and a lone modifier changes nothing', () => {
    const modifier = run([...click, { type: 'key', key: 'Shift' }])
    assert.equal(modifier.state.running, true)
    const key = run([start, far, { type: 'key', key: 'PageDown' }])
    assert.equal(key.state.running, false)
    assert.equal(key.consumed[2], false)
    assert.deepEqual(key.state.held, [1])
    assert.deepEqual(run([middleUp], key.state).consumed, [true])
})

test('a move without the middle bit stops it only while the starting release is awaited', () => {
    const lost: AutoscrollEvent = { type: 'move', button: -1, buttons: 0, dx: 0, dy: 30 }
    const awaiting = run([start, lost])
    assert.equal(awaiting.state.running, false)
    assert.deepEqual(awaiting.state.held, [])
    assert.deepEqual(awaiting.state.trailing, [])
    assert.equal(run([...click, lost]).state.running, true)
})

test('a chorded press stops the motion and is owned', () => {
    const { state } = run([start, { type: 'move', button: -1, buttons: 5, dx: 0, dy: 0 }])
    assert.equal(state.running, false)
    assert.deepEqual(
        run([{ type: 'down', button: 0, buttons: 5, primary: false }], state).consumed,
        [true],
    )
})

test('pointercancel, a wheel and a touch stop it', () => {
    assert.equal(run([...click, { type: 'cancel' }]).state.running, false)
    assert.equal(run([...click, { type: 'wheel' }]).state.running, false)
    assert.equal(run([...click, { type: 'touch' }]).state.running, false)
    assert.deepEqual(run([start, { type: 'cancel' }]).state.held, [])
})

test('a refused middle press is owned, and its release does not start anything', () => {
    const { state, consumed } = run([
        { type: 'refuse', button: 1 },
        middleUp,
        { type: 'click', button: 1 },
    ])
    assert.equal(state.running, false)
    assert.deepEqual(consumed, [false, true, true])
})

test('releasing middle before left after a stopping press is a release, in either event', () => {
    const stopByLeft: AutoscrollEvent = { type: 'move', button: 0, buttons: 5, dx: 0, dy: 0 }
    const leftDown: AutoscrollEvent = { type: 'down', button: 0, buttons: 5, primary: false }
    // Middle is released while left stays down: a move that names the button.
    const viaMove = run([start, far, stopByLeft, leftDown])
    assert.equal(viaMove.state.running, false)
    assert.deepEqual(viaMove.state.held, [1, 0])
    const afterMove = run(
        [
            { type: 'move', button: 1, buttons: 1, dx: 0, dy: 0 },
            { type: 'up', button: 1, buttons: 1 },
            { type: 'click', button: 1 },
            { type: 'up', button: 0, buttons: 0 },
            { type: 'click', button: 0 },
        ],
        viaMove.state,
    )
    assert.deepEqual(afterMove.consumed, [false, true, true, true, true])
    assert.deepEqual(afterMove.state.held, [])
    assert.deepEqual(afterMove.state.trailing, [])
    // The same through the middle button's own mouseup.
    const viaUp = run([{ type: 'up', button: 1, buttons: 1 }], viaMove.state)
    assert.deepEqual(viaUp.state.held, [0])
    assert.deepEqual(viaUp.state.trailing, [1])
})

test('a middle release reported on a move starts click mode, not a lost release', () => {
    const quiet = run([start, near, { type: 'move', button: 1, buttons: 0, dx: 0, dy: 0 }])
    // The move names the middle button: an observed release inside the dead zone, so click mode.
    assert.equal(quiet.state.running, true)
    assert.equal(quiet.state.awaiting, false)
    assert.deepEqual(quiet.state.trailing, [1])
})
