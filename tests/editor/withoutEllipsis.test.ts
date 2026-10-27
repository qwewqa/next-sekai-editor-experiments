import assert from 'node:assert/strict'
import test from 'node:test'
import { withoutEllipsis } from '../../src/editor/commands/withoutEllipsis'

test('a command title loses only its trailing ellipsis', () => {
    assert.equal(withoutEllipsis('Open…'), 'Open')
    assert.equal(withoutEllipsis('Save As…'), 'Save As')
    assert.equal(withoutEllipsis('Open...'), 'Open')
    assert.equal(withoutEllipsis('Save'), 'Save')
    assert.equal(withoutEllipsis('A…B'), 'A…B')
})
