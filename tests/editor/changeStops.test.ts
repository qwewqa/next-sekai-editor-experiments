import assert from 'node:assert/strict'
import test from 'node:test'
import {
    countOff,
    nearestStop,
    nextStop,
    reachable,
    stopToward,
    stopsOf,
    type Place,
} from '../../src/editor/history/changeStops'

// Where a peeked entry's changes are: stops that fit on screen at the zoom, the
// edge arrows' counts and targets, and Show Change stepping up in chart order and wrapping.

const at = (...times: number[]): Place[] => times.map((time) => ({ time, left: 0, right: 2 }))

test('stops group changes within 80% of the band, so a narrower band makes more of them', () => {
    const places = at(1, 2, 3, 10, 11, 30)
    assert.deepEqual(
        stopsOf(places, 10).map(({ from, to }) => [from, to]),
        [
            [1, 3],
            [10, 11],
            [30, 30],
        ],
    )
    assert.equal(stopsOf(places, 2).length, 4)
    assert.equal(stopsOf(places, 100).length, 1)
})

test('the arrows count changes wholly beyond the band; a band shortened by a sheet counts more', () => {
    const places = at(1, 5, 9, 20)
    assert.deepEqual(countOff(places, { top: 10, bottom: 4 }), { above: 1, below: 1 })
    // The History sheet covers the lower part: its band's bottom is later.
    assert.deepEqual(countOff(places, { top: 10, bottom: 6 }), { above: 1, below: 2 })
})

test("Show Change steps up from the band's middle and wraps; arrows take the nearest that way", () => {
    const stops = stopsOf(at(2, 20, 40), 5)
    const band = (middle: number) => ({ top: middle + 2.5, bottom: middle - 2.5 })
    assert.equal(nextStop(stops, band(2))?.from, 20)
    assert.equal(nextStop(stops, band(20))?.from, 40)
    assert.equal(nextStop(stops, band(40))?.from, 2)
    assert.equal(stopToward(stops, band(20), 'up')?.from, 40)
    assert.equal(stopToward(stops, band(20), 'down')?.from, 2)
    assert.equal(stopToward(stops, band(40), 'up'), undefined)
    assert.equal(nearestStop(stops, band(17))?.from, 20)
})

test('with every change in view, nothing moves', () => {
    const stops = stopsOf(at(3, 4), 10)
    assert.equal(nextStop(stops, { top: 10, bottom: 0 }), undefined)
    assert.equal(nearestStop(stops, { top: 10, bottom: 0 }), undefined)
    assert.equal(nextStop([], { top: 10, bottom: 0 }), undefined)
})

test('old and new footprints count once per object in each direction', () => {
    assert.deepEqual(
        countOff(
            [
                { id: 0, time: 20, left: 0, right: 1 },
                { id: 0, time: 21, left: 0, right: 1 },
                { id: 1, time: 22, left: 0, right: 1 },
                { id: 0, time: -1, left: 0, right: 1 },
            ],
            { bottom: 0, top: 10 },
        ),
        { above: 2, below: 1 },
    )
})

// The view never goes below the chart's start, so a band shortened by a sheet at view time 0
// can never show what lies before its floor. Such a change counts in neither direction.
test("a change before the band's floor is unreachable: it counts in neither direction and is no stop", () => {
    const places = at(0.2, 3, 20)
    // At view time 0 the band is 0.57 to 9: its bottom is its floor.
    const atStart = { top: 9, bottom: 0.57, floor: 0.57 }
    assert.deepEqual(countOff(places, atStart), { above: 1, below: 0 })
    // Without the floor the 0.2 change counts below, though no scroll can show it.
    assert.deepEqual(countOff(places, { top: 9, bottom: 0.57 }), { above: 1, below: 1 })
    // Scrolled up, the same floor still hides it; the 3 s change counts below, the 20 s above.
    assert.deepEqual(countOff(places, { top: 19, bottom: 10.57, floor: 0.57 }), {
        above: 1,
        below: 1,
    })

    const reach = reachable(places, atStart.floor)
    assert.deepEqual(
        reach.map(({ time }) => time),
        [3, 20],
    )
    const stops = stopsOf(reach, 8.43)
    assert.equal(stopToward(stops, atStart, 'down'), undefined)
    assert.equal(stopToward(stops, atStart, 'up')?.from, 20)
    // A change at the floor itself is reachable.
    assert.deepEqual(countOff(at(0.57), { top: 9, bottom: 5, floor: 0.57 }), { above: 0, below: 1 })
    assert.equal(reachable(at(0.57), 0.57).length, 1)
})

test('Show Change does nothing when the only changes lie before the floor', () => {
    const band = { top: 9, bottom: 0.57, floor: 0.57 }
    const stops = stopsOf(reachable(at(0.1, 0.3), band.floor), 8.43)
    assert.equal(nextStop(stops, band), undefined)
    assert.equal(nearestStop(stops, band), undefined)
    // With a reachable change below the band's middle, it is still shown.
    const some = stopsOf(reachable(at(0.1, 12), band.floor), 8.43)
    assert.equal(nextStop(some, band)?.from, 12)
})
