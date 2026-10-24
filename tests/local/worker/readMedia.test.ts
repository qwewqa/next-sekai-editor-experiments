import assert from 'node:assert/strict'
import test from 'node:test'
import { hashKey } from '../../../src/local/db'
import { fromHex16 } from '../../../src/local/hash'
import { captureMedia } from '../../../src/local/media'
import { createWorld } from '../../../src/local/testing/world'
import type { WorkerContext } from '../../../src/local/worker/handlers'
import { originOperation } from '../../helpers/historySteps'
import '../../helpers/lockChecks'
import { openPage, rows, testId } from '../flush/harness'
import { goldenChart, stateOf } from '../records/charts'
import { readMediaBytes } from '../startup/mediaRead'

// `readMedia`: the bytes of a stored media item, re-hashed, for a state that names
// audio it does not hold. Missing and damaged rows are "not held"; only a read that could not be
// made rejects.

const song = (seed: number) => {
    const bytes = new Uint8Array(2048)
    bytes.set([0x49, 0x44, 0x33, 0x04])
    for (let i = 4; i < bytes.length; i++) bytes[i] = (i * 17 + seed) & 0xff
    return bytes.buffer
}

const stored = async (seed: number) => {
    const world = createWorld({ seed })
    const page = await openPage(world, world.tab('a'))
    const captured = await captureMedia(song(seed), { name: 'song.mp3', type: '' })
    const base = stateOf(goldenChart())
    page.flusher.begin({
        id: testId(),
        docId: testId(),
        origin: 'import',
        state: { ...base, bgm: { ...base.bgm, meta: captured.meta, source: captured.source } },
        operation: originOperation('import'),
        dirty: false,
    })
    await page.flusher.flush()
    assert.equal(rows(world, 'media').size, 1)
    const context: WorkerContext = { core: page.core, test: true, emit: () => undefined }
    return { world, page, captured, context }
}

test('a stored item’s bytes come back whole, to the byte', async () => {
    const { captured, context, page } = await stored(1)
    const bytes = await page.tab.run(() => readMediaBytes(context, captured.meta.hash))
    assert.deepEqual(new Uint8Array(bytes ?? new ArrayBuffer(0)), new Uint8Array(captured.source))
})

test('an item the store lacks, or a malformed hash, is not held rather than an error', async () => {
    const { context, page } = await stored(2)
    assert.equal(await page.tab.run(() => readMediaBytes(context, '0'.repeat(32))), undefined)
    assert.equal(await page.tab.run(() => readMediaBytes(context, 'nope')), undefined)
})

test('a row whose bytes no longer match its key is not held', async () => {
    const { world, context, page, captured } = await stored(3)
    await page.tab.run(() =>
        page.core.write(['media'], async (tx) => {
            const key = hashKey(fromHex16(captured.meta.hash))
            const row = (await tx.get('media', key)) as Record<string, unknown>
            await tx.put('media', { ...row, blob: new Blob([new Uint8Array(2048)]) }, key)
        }),
    )
    assert.equal(rows(world, 'media').size, 1)
    assert.equal(await page.tab.run(() => readMediaBytes(context, captured.meta.hash)), undefined)
})
