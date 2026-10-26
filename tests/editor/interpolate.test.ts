import assert from 'node:assert/strict'
import test from 'node:test'
import { interpolateRaw, setInterpolationLocale } from '../../src/utils/interpolate'
import { setSizeLocale } from '../../src/utils/size'

test('names are inserted verbatim, whatever replacement patterns or placeholders they hold', () => {
    assert.equal(interpolateRaw('Added {0} folder', 'Price $& Co'), 'Added Price $& Co folder')
    assert.equal(
        interpolateRaw('Renamed {0} folder to {1}', 'Old {1}', 'New'),
        'Renamed Old {1} folder to New',
    )
    assert.equal(
        interpolateRaw('Renamed {0} folder to {1}', "Chorus $'", 'Bridge $`$$'),
        "Renamed Chorus $' folder to Bridge $`$$",
    )
})

test('plural forms follow the first value, and missing values leave their placeholder', () => {
    assert.equal(interpolateRaw('Added {0} note|Added {0} notes', '1'), 'Added 1 note')
    assert.equal(interpolateRaw('Added {0} note|Added {0} notes', '2'), 'Added 2 notes')
    assert.equal(interpolateRaw('Added {0} {1} event', '2'), 'Added 2 {1} event')
})

test('a number picks the plural form as it is and shows with the locale’s grouping', () => {
    assert.equal(interpolateRaw('Added {0} note|Added {0} notes', 1), 'Added 1 note')
    assert.equal(interpolateRaw('Added {0} note|Added {0} notes', 1000), 'Added 1,000 notes')
})

test('a count of 1,000 takes the plural form in Turkish, whose formatted count reads "1.000"', () => {
    const title = 'Klasörü ve grupları sil|Klasörleri ve grupları sil'
    setInterpolationLocale(() => 'tr')
    setSizeLocale(() => 'tr')
    try {
        assert.equal(interpolateRaw(title, 1), 'Klasörü ve grupları sil')
        assert.equal(interpolateRaw(title, 1000), 'Klasörleri ve grupları sil')
        assert.equal(interpolateRaw('{0} klasör', 1000), '1.000 klasör')
    } finally {
        setInterpolationLocale(() => 'en')
        setSizeLocale(() => 'en')
    }
})
