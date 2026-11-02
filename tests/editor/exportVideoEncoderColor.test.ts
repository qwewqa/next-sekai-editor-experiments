import assert from 'node:assert/strict'
import test from 'node:test'
import { chooseColor, colorCandidates } from '../../src/exportVideo/worker/encoderColor'

const report = (matrix: VideoMatrixCoefficients, fullRange: boolean): VideoColorSpaceInit => ({
    primaries: 'bt709',
    transfer: 'bt709',
    matrix,
    fullRange,
})

test('the measured conversion replaces the report only when it is clearly closer', () => {
    // Measured in Firefox (converts with BT.601 limited, reports BT.709 limited) and in Chromium
    // (converts as it reports).
    assert.deepEqual(chooseColor([12.94, 6.89, 11.44, 0.78], report('bt709', false)), {
        matrix: 'smpte170m',
        fullRange: false,
    })
    assert.equal(chooseColor([0.06, 10.44, 5.89, 11.67], report('bt709', true)), undefined)
    for (const [i, candidate] of colorCandidates.entries()) {
        const distances = colorCandidates.map((_, j) => (i === j ? 0.5 : 8))
        const other = colorCandidates[(i + 1) % colorCandidates.length]!
        assert.deepEqual(chooseColor(distances, report(other.matrix, other.fullRange)), candidate)
        assert.equal(
            chooseColor(distances, report(candidate.matrix, candidate.fullRange)),
            undefined,
        )
    }
    // A near tie, or no candidate that matches, keeps the report.
    assert.equal(chooseColor([1.5, 3, 8, 9], report('bt709', false)), undefined)
    assert.equal(chooseColor([4, 7, 8, 9], report('bt709', false)), undefined)
    // bt470bg has the BT.601 coefficients.
    assert.equal(chooseColor([8, 8, 8, 0.5], report('bt470bg', false)), undefined)
    assert.deepEqual(chooseColor([0.5, 8, 8, 8], undefined), colorCandidates[0])
})
