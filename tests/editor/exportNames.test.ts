import assert from 'node:assert/strict'
import test from 'node:test'
import {
    NAME_BYTE_LIMIT,
    nameProblem,
    showsAtOnce,
    validName,
} from '../../src/editor/commands/exportLevel/fileName'
import { insertExportLevel } from '../../src/settings/toolbarExport'

test('a typed file name is checked against the portable rules 1–4', () => {
    assert.equal(nameProblem('Coconut (Master)'), undefined)
    assert.equal(nameProblem(''), undefined)
    assert.equal(nameProblem('Café 日本語'), undefined)
    assert.deepEqual(nameProblem('Re:Zero'), { reason: 'invalidChar', char: ':' })
    for (const char of ['\\', '/', '*', '?', '"', '<', '>', '|'])
        assert.deepEqual(nameProblem(`a${char}b`), { reason: 'invalidChar', char })
    assert.deepEqual(nameProblem('a\u0007b'), { reason: 'controlChar' })
    assert.deepEqual(nameProblem('.hidden'), { reason: 'edgeDotSpace' })
    assert.deepEqual(nameProblem('Coconut '), { reason: 'edgeDotSpace' })
    assert.deepEqual(nameProblem('con'), { reason: 'reserved', name: 'con' })
    assert.deepEqual(nameProblem('LPT1.nsld'), { reason: 'reserved', name: 'LPT1' })
    assert.equal(nameProblem('Console'), undefined)
    assert.equal(nameProblem('a'.repeat(NAME_BYTE_LIMIT)), undefined)
    assert.deepEqual(nameProblem('a'.repeat(NAME_BYTE_LIMIT + 1)), { reason: 'tooLong' })
    // Counted as UTF-8 bytes: 67 three-byte characters are 201 bytes.
    assert.deepEqual(nameProblem('日'.repeat(67)), { reason: 'tooLong' })
})

test('a forbidden character or reserved name shows at once, the rest after a pause', () => {
    assert.equal(showsAtOnce({ reason: 'invalidChar', char: ':' }), true)
    assert.equal(showsAtOnce({ reason: 'controlChar' }), true)
    assert.equal(showsAtOnce({ reason: 'reserved', name: 'CON' }), true)
    assert.equal(showsAtOnce({ reason: 'edgeDotSpace' }), false)
    assert.equal(showsAtOnce({ reason: 'tooLong' }), false)
})

test('a suggested name is made valid by the one replacement', () => {
    assert.equal(validName('Re:Zero'), 'Re.Zero')
    assert.equal(validName('a/b*c?"d<e>f|g\\h'), 'a-b-c--d-e-f-g-h')
    assert.equal(validName(' .Coconut. '), 'Coconut')
    assert.equal(validName('CON'), 'CON-')
    assert.equal(validName('Café'), 'Café')
    const long = validName('日'.repeat(100))
    assert.ok(new TextEncoder().encode(long).length <= NAME_BYTE_LIMIT)
    assert.ok(long.endsWith('…'))
    assert.equal(nameProblem(validName('  CON:x?  ')), undefined)
})

test('the toolbar step puts Export Level Data before Save in whichever group has it', () => {
    assert.deepEqual(
        insertExportLevel([['utilities', 'properties', 'reset', 'save', 'open'], ['play']]),
        [['utilities', 'properties', 'reset', 'exportLevel', 'save', 'open'], ['play']],
    )
    // A customised group gets it too.
    assert.deepEqual(insertExportLevel([['undo'], ['save', 'copy']]), [
        ['undo'],
        ['exportLevel', 'save', 'copy'],
    ])
    const without = [['open'], ['play']]
    assert.equal(insertExportLevel(without), without)
    const already = [['exportLevel'], ['save']]
    assert.equal(insertExportLevel(already), already)
})
