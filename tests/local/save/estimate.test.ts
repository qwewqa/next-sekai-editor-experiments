import assert from 'node:assert/strict'
import test from 'node:test'
import { cachedEstimate, estimateSaveSize } from '../../../src/local/save/estimate'
import { saveHandlers } from '../../../src/local/worker/saveHandlers'
import { ZipReader } from '../../../src/zip/reader'
import { BGM, COVER, PREVIEW } from '../nxsp/helpers'
import { Fixture, save } from './fixture'

// `estimateSaveSize`: from stored sizes, cached per chain, close to the file.

/** The written file's history entries and the rest, by their stored sizes. */
const measured = async (file: Blob) => {
    const reader = await ZipReader.open(file)
    let history = 0
    let bgm = 0
    for (const entry of reader.entries) {
        if (entry.name.startsWith('history/'))
            history += entry.compressedSize + 30 + 46 + 2 * entry.name.length
        else if (entry.name.startsWith('bgm/')) bgm += entry.compressedSize
    }
    return { history, bgm, base: file.size - history - bgm }
}

test('the estimate is within 25% of the written file, with History and without, and cached', async () => {
    const fixture = await Fixture.create()
    await fixture.storeMedia([BGM, COVER, PREVIEW])
    await fixture.start(0)
    for (let k = 1; k <= 60; k++) {
        await fixture.edit(k)
        if (k % 7 === 0) {
            fixture.undo()
            fixture.redo()
        }
    }
    await fixture.flush()
    const estimate = await estimateSaveSize(fixture.store, fixture.chainId)
    assert.ok(estimate)
    const { file } = await save(fixture, { kind: 'copy' }, { binds: false })
    assert.ok(file)
    const actual = await measured(file)
    const total = estimate.base + estimate.history + (estimate.bgm ?? 0)
    const ratio = total / file.size
    assert.ok(
        ratio > 0.75 && ratio < 1.25,
        `total ${total} for ${file.size} (${JSON.stringify({ estimate, actual })})`,
    )
    const { file: bare } = await save(
        fixture,
        { kind: 'copy' },
        { binds: false, extra: { history: false } },
    )
    assert.ok(bare)
    const without = (estimate.base + (estimate.bgm ?? 0)) / bare.size
    assert.ok(without > 0.75 && without < 1.25, `without history ${without}`)
    assert.equal(estimate.bgm, BGM.bytes.length)
    // A reopen with no new entries has it at once.
    assert.deepEqual(
        cachedEstimate(fixture.chainId, fixture.session.id, fixture.session.rows.at(-1)?.seq ?? 0),
        estimate,
    )
})

test('the cache is for the BGM the page names: another BGM is a new estimate', async () => {
    const fixture = await Fixture.create()
    await fixture.storeMedia([BGM, COVER, PREVIEW])
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.flush()
    const named = await estimateSaveSize(fixture.store, fixture.chainId, { bgm: BGM.ref.hash })
    assert.ok(named)
    assert.equal(named.bgm, BGM.bytes.length)
    // The same session and `lastSeq`, with another item named: its size is the one reported.
    const other = await estimateSaveSize(fixture.store, fixture.chainId, { bgm: COVER.ref.hash })
    assert.ok(other)
    assert.equal(other.bgm, COVER.bytes.length)
    assert.notEqual(other.bgm, named.bgm)
    // Asking for the first again is a fresh estimate for it, and equal.
    assert.deepEqual(
        await estimateSaveSize(fixture.store, fixture.chainId, { bgm: BGM.ref.hash }),
        named,
    )
})

test('an estimate counted while an open’s import runs is not kept: the next one counts again', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    for (let k = 1; k <= 5; k++) await fixture.edit(k)
    await fixture.flush()
    const id = fixture.session.id
    const setImporting = (on: boolean) =>
        fixture.store.write(['sessions'], async (tx) => {
            const row = { ...((await tx.get('sessions', id)) as Record<string, unknown>) }
            if (on) row.importPending = true
            else delete row.importPending
            await tx.put('sessions', row)
        })
    await setImporting(true)
    const during = await estimateSaveSize(fixture.store, fixture.chainId)
    assert.equal(during?.importing, true)
    const lastSeq = fixture.session.rows.at(-1)?.seq ?? 0
    assert.equal(cachedEstimate(fixture.chainId, id, lastSeq), undefined)
    // The import lands, with no new `seq`: the estimate is counted again, and kept.
    await setImporting(false)
    const after = await estimateSaveSize(fixture.store, fixture.chainId)
    assert.ok(after)
    assert.equal(after.importing, undefined)
    assert.notEqual(after, during)
    assert.deepEqual(cachedEstimate(fixture.chainId, id, lastSeq), after)
})

test('the worker’s estimate moves its call’s progress at each read, so a slow one is not taken for a hung worker', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    for (let k = 1; k <= 5; k++) await fixture.edit(k)
    await fixture.flush()
    const handlers = saveHandlers({ core: fixture.core, test: true, emit: () => undefined })
    let ticks = 0
    const estimate = await fixture.tab.run(() =>
        handlers.estimateSaveSize(
            { chainId: fixture.chainId },
            {
                id: 1,
                tick: () => {
                    ticks++
                },
            },
        ),
    )
    assert.ok(estimate)
    // Each read ticks as it starts and ends.
    assert.ok(ticks >= 2, `${ticks} ticks`)
})
