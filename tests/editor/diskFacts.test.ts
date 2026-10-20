import assert from 'node:assert/strict'
import test from 'node:test'
import { readDiskFacts } from '../../src/editor/save/disk'
import { executePlan, planNxsp } from '../../src/local/nxsp'
import { fresh, NOW } from '../local/nxsp/chain'
import { crafted, jsonOf, setJson, type Loose } from '../local/nxsp/craft'

// What a `.nxsp` on disk is, as the conflict dialog and the Replace guard read it (Part 0 §0.9.6):
// by the reader's own rules, so an odd `savedAt` or a stale `summary` is never half-believed.

const freshFile = () => executePlan(planNxsp(fresh().input).plan, new Map())

const factsOf = async (change: (project: Loose) => void) =>
    readDiskFacts(
        await crafted(
            (items) => {
                const project = jsonOf(items, 'project.json')
                change(project)
                setJson(items, 'project.json', project)
            },
            await freshFile(),
        ),
    )

test('a saved version reads its device, RFC 3339 time and the summary of its own revision', async () => {
    const facts = await factsOf(() => undefined)
    assert.equal(facts.version.kind, 'saved')
    if (facts.version.kind !== 'saved') return
    // The writer's `savedAt` is the build's clock to the second.
    assert.equal(facts.version.savedAt, Math.floor(NOW / 1000) * 1000)
    assert.deepEqual(facts.version.device, {
        id: 'c3f00000-0000-4000-8000-000000000000',
        label: 'Web (Chrome)',
    })
    assert.ok(facts.version.notes! > 0)
})

test('a savedAt that is not RFC 3339 reads as an unknown version, never a guessed time', async () => {
    for (const savedAt of ['Oct 19 2026', '2026-10-16 05:41:07Z', '2026-10-16T05:41:07', 5, null]) {
        const facts = await factsOf((p) => (p.revision.savedAt = savedAt))
        assert.deepEqual(facts.version, { kind: 'unknown' }, JSON.stringify(savedAt))
    }
    // An offset is RFC 3339 too, and means the same instant.
    const offset = await factsOf((p) => (p.revision.savedAt = '2026-10-16T14:41:07+09:00'))
    const utc = await factsOf((p) => (p.revision.savedAt = '2026-10-16T05:41:07Z'))
    assert.deepEqual(offset.version, utc.version)
    assert.equal(utc.version.kind, 'saved')
})

test('the summary counts only for the revision it was computed for', async () => {
    const current = await factsOf(() => undefined)
    const stale = await factsOf((p) => (p.summary.revisionId = 'another-revision'))
    assert.equal(current.version.kind, 'saved')
    assert.equal(stale.version.kind, 'saved')
    if (current.version.kind !== 'saved' || stale.version.kind !== 'saved') return
    assert.ok(current.version.notes! > 0)
    // A stale summary says nothing about the file: no count, never 0.
    assert.ok(!('notes' in stale.version))
})
