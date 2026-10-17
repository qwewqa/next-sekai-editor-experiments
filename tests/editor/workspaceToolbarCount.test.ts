import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('the dock is sized for the toolbar groups that are drawn, not those with no registered command', () => {
    // The workspace module loads the command registry and Vue, so its source is checked instead.
    const source = readFileSync('src/editor/workspace/index.ts', 'utf8')
    const counts = source.match(/toolbarGroups\([^)]*\)/g) ?? []
    assert.ok(counts.length >= 2)
    for (const count of counts) assert.match(count, /registeredGroups\(settings\.toolbar,/)
})
