import assert from 'node:assert/strict'
import test from 'node:test'
import { chipSeverity, chipStates, rowBadges } from '../../src/editor/file/chip'
import { formatSize } from '../../src/utils/size'

test('the chip slot takes the highest-priority state and lists the rest', () => {
    assert.deepEqual(chipStates(['newerOnDisk', 'changedOnDisk', 'notStored']), [
        'notStored',
        'changedOnDisk',
        'newerOnDisk',
    ])
    assert.deepEqual(chipStates(['newerOnDisk', 'fileMissing']), ['fileMissing', 'newerOnDisk'])
    assert.deepEqual(chipStates([]), [])
})

test('the chip draws its icon by severity', () => {
    assert.equal(chipSeverity('notStored'), 'warning')
    assert.equal(chipSeverity('fileMissing'), 'warning')
    assert.equal(chipSeverity('changedOnDisk'), 'warning')
    assert.equal(chipSeverity('newerOnDisk'), 'info')
})

test('a row shows at most two badges: its state, then open in another tab', () => {
    assert.deepEqual(rowBadges(['changedOnDisk', 'newerOnDisk'], true), [
        'changedOnDisk',
        'openElsewhere',
    ])
    assert.deepEqual(rowBadges([], true), ['openElsewhere'])
    assert.deepEqual(rowBadges(['newerOnDisk'], false), ['newerOnDisk'])
    assert.deepEqual(rowBadges([], false), [])
})

test('sizes use decimal units, one decimal below 100 of a unit and none from 100', () => {
    // A no-break space keeps the unit with its number when a line wraps.
    const nb = (text: string) => text.replace(' ', ' ')
    assert.equal(formatSize(0, 'en'), nb('0 kB'))
    assert.equal(formatSize(200, 'en'), nb('0.2 kB'))
    assert.equal(formatSize(12_400, 'en'), nb('12.4 kB'))
    assert.equal(formatSize(123_456, 'en'), nb('123 kB'))
    assert.equal(formatSize(1_240_000, 'en'), nb('1.2 MB'))
    assert.equal(formatSize(99_960_000, 'en'), nb('100 MB'))
    assert.equal(formatSize(3_100_000_000, 'en'), nb('3.1 GB'))
    assert.equal(formatSize(7_600_000, 'de'), nb('7,6 MB'))
})
