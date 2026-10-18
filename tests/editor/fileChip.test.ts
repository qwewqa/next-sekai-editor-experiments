import assert from 'node:assert/strict'
import test from 'node:test'
import { chipSeverity, chipStates, rowBadges } from '../../src/editor/file/chip'
import { formatSize } from '../../src/utils/size'

test('the chip slot takes the highest-priority state and lists the rest', () => {
    assert.deepEqual(chipStates(['notConfirmed', 'changedOnDisk', 'notStored']), [
        'notStored',
        'changedOnDisk',
        'notConfirmed',
    ])
    assert.deepEqual(chipStates(['newerOnDisk', 'fileMissing']), ['fileMissing', 'newerOnDisk'])
    assert.deepEqual(chipStates([]), [])
})

test('the chip draws its icon by severity', () => {
    assert.equal(chipSeverity('notStored'), 'warning')
    assert.equal(chipSeverity('fileMissing'), 'warning')
    assert.equal(chipSeverity('changedOnDisk'), 'warning')
    assert.equal(chipSeverity('newerOnDisk'), 'info')
    assert.equal(chipSeverity('notConfirmed'), 'info')
})

test('a row shows at most two badges: its state, then open in another tab', () => {
    assert.deepEqual(rowBadges(['changedOnDisk', 'notConfirmed'], true), [
        'changedOnDisk',
        'openElsewhere',
    ])
    assert.deepEqual(rowBadges([], true), ['openElsewhere'])
    assert.deepEqual(rowBadges(['notConfirmed'], false), ['notConfirmed'])
    assert.deepEqual(rowBadges([], false), [])
})

test('sizes use decimal units, one decimal below 100 of a unit and none from 100', () => {
    assert.equal(formatSize(0, 'en'), '0 kB')
    assert.equal(formatSize(200, 'en'), '0.2 kB')
    assert.equal(formatSize(12_400, 'en'), '12.4 kB')
    assert.equal(formatSize(123_456, 'en'), '123 kB')
    assert.equal(formatSize(1_240_000, 'en'), '1.2 MB')
    assert.equal(formatSize(99_960_000, 'en'), '100 MB')
    assert.equal(formatSize(3_100_000_000, 'en'), '3.1 GB')
    assert.equal(formatSize(7_600_000, 'de'), '7,6 MB')
})
