import assert from 'node:assert/strict'
import test from 'node:test'
import { formatBpm, formatTime, formatTimeScale } from '../../src/utils/format'

test('times format to the millisecond and carry rounding into seconds and minutes', () => {
    assert.equal(formatTime(0), '00:00.000')
    assert.equal(formatTime(1.25), '00:01.250')
    assert.equal(formatTime(0.9996), '00:01.000')
    assert.equal(formatTime(59.9996), '01:00.000')
    assert.equal(formatTime(119.9995), '02:00.000')
    assert.equal(formatTime(61.0004), '01:01.000')
    assert.equal(formatTime(754.5), '12:34.500')
})

test('BPM and time-scale labels round as Properties shows numbers', () => {
    assert.equal(formatBpm(150.123456789), '150.1235')
    assert.equal(formatBpm(120), '120')
    assert.equal(formatTimeScale(1.123456789, 0), '1.1235x')
    assert.equal(formatTimeScale(0.5, 1.23456789), '0.5x+1.2346')
    assert.equal(formatTimeScale(2, -0.25), '2x-0.25')
    // A skip that rounds to 0 shows none.
    assert.equal(formatTimeScale(1, 0.00001), '1x')
    assert.equal(formatTimeScale(1, -0.00001), '1x')
})
