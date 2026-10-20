import assert from 'node:assert/strict'
import test from 'node:test'
import { createPlaces, singleFlight } from '../../src/editor/history/hereChecks'

// A chain with true places: the first scan's newest entry is 0, newer entries are negative. A
// check counts positions from its own newest entry and reaches the previous newest entry at the
// distance between them.
test('places stay on one origin across successive checks', () => {
    const places = createPlaces()
    let top = 0
    const check = (newest: number, matches: number[]) => {
        const reached = top - newest
        const found = matches.map((place) => places.of(place - newest, reached))
        places.advance(reached)
        top = newest
        return found
    }
    // Three checks: newest entries at -1, -4 and -5; matches are given by true place.
    assert.deepEqual(check(-1, [-1]), [-1])
    assert.deepEqual(check(-4, [-4, -2]), [-4, -2])
    assert.deepEqual(check(-5, [-5]), [-5])
    // Two adjacent edits stay adjacent (they fold into one run), unrelated ones do not.
    const adjacent = createPlaces()
    const first = adjacent.of(0, 1)
    adjacent.advance(1)
    const second = adjacent.of(0, 1)
    assert.equal(first, -1)
    assert.equal(second, -2)
})

test('a check that reaches its own newest entry shifts nothing', () => {
    const places = createPlaces()
    places.advance(0)
    assert.equal(places.of(2, 0), 2)
    places.advance(3)
    assert.equal(places.of(1, 3), -5)
})

test('reset starts a new origin', () => {
    const places = createPlaces()
    places.advance(4)
    places.reset()
    assert.equal(places.of(2, 2), 0)
})

test('the single-flight queue runs again for a request made while it runs', async () => {
    let runs = 0
    let release: () => void = () => {}
    const once = async () => {
        runs++
        if (runs === 1) await new Promise<void>((resolve) => (release = resolve))
    }
    const run = singleFlight(once)
    const first = run()
    const second = run()
    assert.equal(first, second)
    release()
    await first
    assert.equal(runs, 2)
})

test('a request made as the run finishes is followed by a run', async () => {
    let runs = 0
    let late: Promise<void> | undefined
    let run: () => Promise<void> = () => Promise.resolve()
    run = singleFlight(() => {
        runs++
        const done = Promise.resolve()
        // Registered before the loop's own continuation: lands just before its comparison.
        if (runs === 1)
            void done.then(() => {
                late = run()
            })
        return done
    })
    await run()
    await late
    assert.equal(runs, 2)
    // Once idle, the next request starts a run of its own.
    await run()
    assert.equal(runs, 3)
})
