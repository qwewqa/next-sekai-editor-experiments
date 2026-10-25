import assert from 'node:assert/strict'
import test from 'node:test'
import { formatCount, formatDecimal, formatSize } from '../../src/utils/size'

// The formatters share cached Intl.NumberFormat instances; a cache key that ignored the locale or
// the options would show one locale's grouping, or a size's fraction digits, in another place.
test('cached number formats keep each locale and option set apart', () => {
    for (let pass = 0; pass < 2; pass++) {
        assert.equal(formatCount(1840, 'en'), '1,840')
        assert.equal(formatCount(1840, 'de'), '1.840')
        assert.equal(formatDecimal(0.5, 'en'), '0.5')
        assert.equal(formatDecimal(0.5, 'fr'), '0,5')
        assert.equal(formatDecimal(0.12345, 'en'), '0.123')
        assert.equal(formatSize(12_400, 'en'), '12.4\u00a0kB')
        assert.equal(formatSize(123_000_000, 'en'), '123\u00a0MB')
        assert.equal(formatSize(1_240_000, 'en'), '1.2\u00a0MB')
    }
})
