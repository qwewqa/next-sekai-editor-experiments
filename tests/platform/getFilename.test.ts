import assert from 'node:assert/strict'
import test from 'node:test'
import { getFilename } from '../../src/utils/file'

const name = (value: string) => getFilename({ name: value })

test('getFilename strips only known extensions', () => {
    assert.equal(name('coconut.nxsp'), 'coconut')
    assert.equal(name('coconut.nsld'), 'coconut')
    assert.equal(name('coconut.json.gz'), 'coconut')
    assert.equal(name('coconut.gz'), 'coconut')
    assert.equal(name('coconut.json'), 'coconut')
    assert.equal(name('coconut.usc'), 'coconut')
    assert.equal(name('coconut.sus'), 'coconut')
    assert.equal(name('coconut.zip'), 'coconut')
    assert.equal(name('skin.scp'), 'skin')
    for (const extension of ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'webm', 'opus']) {
        assert.equal(name(`song.${extension}`), 'song', extension)
    }
})

test('getFilename keeps dots in the name', () => {
    assert.equal(name('v1.2 final.nxsp'), 'v1.2 final')
    assert.equal(name('a.b.c.mp3'), 'a.b.c')
    assert.equal(name('level.v2.json.gz'), 'level.v2')
    assert.equal(name('report.final'), 'report.final')
    assert.equal(name('LevelData'), 'LevelData')
})

test('getFilename ignores case, strips one extension and trims', () => {
    assert.equal(name('Coconut.NXSP'), 'Coconut')
    assert.equal(name('Coconut.Json.GZ'), 'Coconut')
    assert.equal(name('coconut.json.nxsp'), 'coconut.json')
    assert.equal(name('  spaced name .mp3'), 'spaced name')
    assert.equal(name('ココナッツ.nsld'), 'ココナッツ')
})
