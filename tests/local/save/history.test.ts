import assert from 'node:assert/strict'
import test from 'node:test'
import { nxspDiskState } from '../../../src/platform/fingerprint'
import { BGM, COVER, PREVIEW } from '../nxsp/helpers'
import { Fixture, heldRows, save, sourceOf } from './fixture'

// The settled history model over chains in storage: appends, the cut,
// `completeFrom` and the line, and what each write changes.

const diskOf = (file: File) => nxspDiskState(file, file.lastModified).then((disk) => ({ ...disk }))

/** A chain of two edits, saved once to a new file, bound. */
const savedChain = async () => {
    const fixture = await Fixture.create()
    await fixture.storeMedia()
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.edit(2)
    await fixture.flush()
    const first = await save(fixture, { kind: 'copy' }, { disk: diskOf })
    assert.ok(!('refused' in first.built), JSON.stringify(first.built))
    assert.ok(first.file)
    return { fixture, file: first.file, built: first.built }
}

test('a first Save holds the chronology, the media, and its own id as completeFrom', async () => {
    const { fixture, file, built } = await savedChain()
    assert.ok(!('refused' in built))
    const { read, history } = await heldRows(file)
    assert.equal(read.open, 'full')
    assert.deepEqual(
        history.entries.map((entry) => entry.kind),
        ['init', 'edit', 'edit', 'save'],
    )
    assert.equal(read.project?.revision?.completeFrom, built.revisionId)
    assert.equal(read.project?.revision?.parent, null)
    assert.equal(built.stepsLine, 'none')
    assert.deepEqual(built.without, [])
    assert.equal(read.media.bgm?.form.sha256, BGM.sha256)
    assert.equal(read.media.cover?.form.sha256, COVER.sha256)
    assert.equal(read.media.preview?.form.sha256, PREVIEW.sha256)
    assert.deepEqual(built.identity.entry, { count: 4, notKept: 0 })
    const chain = await fixture.chain()
    assert.equal((chain.revision as { id: string }).id, built.revisionId)
})

test('a write-back appends: the old file’s parts copied whole, then the rows after the cut', async () => {
    const { fixture, file, built } = await savedChain()
    assert.ok(!('refused' in built))
    await fixture.edit(3)
    await fixture.flush()
    const second = await save(
        fixture,
        { kind: 'append', source: 'target' },
        {
            files: [await sourceOf(file)],
            disk: diskOf,
        },
    )
    assert.ok(!('refused' in second.built), JSON.stringify(second.built))
    assert.ok(second.file)
    const before = await heldRows(file)
    const after = await heldRows(second.file)
    assert.equal(after.read.open, 'full')
    assert.deepEqual(
        after.history.entries.map((entry) => entry.kind),
        ['init', 'edit', 'edit', 'save', 'edit', 'save'],
    )
    // The old rows are the new file's first rows, as values.
    assert.deepEqual(after.history.entries.slice(0, 4), before.history.entries)
    assert.equal(after.read.project?.revision?.completeFrom, built.revisionId)
    assert.equal(second.built.stepsLine, 'none')
    // chunks.bin begins with the old one, unchanged.
    const oldChunks = new Uint8Array(await chunksOf(file))
    const newChunks = new Uint8Array(await chunksOf(second.file))
    assert.deepEqual(newChunks.subarray(0, oldChunks.length), oldChunks)
})

const chunksOf = async (file: Blob) => {
    const { ZipReader } = await import('../../../src/zip/reader')
    const reader = await ZipReader.open(file)
    const entry = reader.get('history/chunks.bin')
    assert.ok(entry)
    return (await reader.read(entry, { maxSize: 1 << 30 })).slice().buffer
}
