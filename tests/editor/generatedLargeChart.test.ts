import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parseLevelData } from '../../src/levelData/parse'

const generate = () =>
    execFileSync(process.execPath, ['scripts/generate-large-chart.mjs', '--stdout'], {
        maxBuffer: 64 * 1024 * 1024,
    }).toString()

const committed = readFileSync('tests/fixtures/generated-large.json', 'utf8')

test('the generator is deterministic', () => {
    assert.equal(generate(), generate())
})

test('the committed generated chart is what the script writes', () => {
    assert.equal(committed, generate())
})

// The chart parser pulls in .vue files, so the browser memory spec parses it; this checks the file format.
test("the generated chart is about coconut's size and level data the editor accepts", () => {
    const data = parseLevelData(JSON.parse(committed))
    assert.ok(committed.length > 1_200_000 && committed.length < 1_700_000)
    assert.ok(data.entities.length > 3000 && data.entities.length < 4000)
    assert.ok(data.entities.some((entity) => entity.archetype === 'Connector'))
})
