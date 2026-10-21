import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import test from 'node:test'

// Spec A7: only sessions.ts makes a lease, only the flusher takes one, and the old raw-lock type
// is gone.
const src = join(import.meta.dirname, '../../src')
const found = (pattern: RegExp) =>
    readdirSync(src, { recursive: true, encoding: 'utf8' })
        .filter(
            (file) =>
                /\.(ts|vue)$/.test(file) && pattern.test(readFileSync(join(src, file), 'utf8')),
        )
        .map((file) => file.replaceAll(sep, '/'))

test('only sessions.ts makes a lease, only the flusher takes one, and HeldLock is gone', () => {
    assert.deepEqual(found(/\blockLease\(/), ['local/sessions.ts'])
    assert.deepEqual(found(/\.take\(\)/), ['local/flush.ts'])
    assert.deepEqual(found(/\bHeldLock\b/), [])
})
