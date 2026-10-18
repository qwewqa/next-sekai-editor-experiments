import assert from 'node:assert/strict'
import test from 'node:test'
import { noteBodyNames } from '../../../src/preview/assets/files/noteBodies'
import { resolveSkin } from '../../../src/preview/skin'

test('every note body name is one the skin resolver asks for', () => {
    const asked = new Set<string>()
    resolveSkin((name) => {
        asked.add(name)
        return undefined
    })
    for (const name of noteBodyNames) assert.ok(asked.has(name), name)
})
