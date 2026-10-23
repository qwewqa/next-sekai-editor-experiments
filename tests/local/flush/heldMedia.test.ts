import assert from 'node:assert/strict'
import test from 'node:test'
import { bumpEpoch, hashKey } from '../../../src/local/db'
import type { MediaKind } from '../../../src/local/flushWrite'
import { fromHex16, toHex } from '../../../src/local/hash'
import { heldItem, holdMedia, resetHeldMediaForTests } from '../../../src/local/heldMedia'
import { captureMedia, sniffImageType } from '../../../src/local/media'
import { unpackHashes } from '../../../src/local/records/rows'
import { checkStored } from '../../../src/local/testing/invariants'
import { crashSweep } from '../../../src/local/testing/sweep'
import { CI_SEEDS, createWorld } from '../../../src/local/testing/world'
import type { WorkerContext } from '../../../src/local/worker/handlers'
import type { State } from '../../../src/state'
import {
    editStep,
    futureFixtureOperation,
    initialLife,
    originOperation,
} from '../../helpers/historySteps'
import '../../helpers/lockChecks'
import { goldenChart, stateOf } from '../records/charts'
import { readMediaBytes } from '../startup/mediaRead'
import { openPage, rows, testId, workerCore, type Page } from './harness'

// A picked cover or preview clip is held by hash (Step 11 design §3.2) and stored with the entry
// first naming it, as the BGM is: in the same transaction as the snapshot, read back, and stored
// again while this tab holds it and the row went missing.

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const MP3 = [0x49, 0x44, 0x33, 0x04]

const fileBytes = (head: readonly number[], seed: number, length = 2048) => {
    const bytes = new Uint8Array(length)
    bytes.set(head)
    for (let i = head.length; i < length; i++) bytes[i] = (i * 29 + seed) & 0xff
    return bytes.buffer
}

type Picked = Awaited<ReturnType<typeof pick>>

/** Picks a file the way the dialog will: captured, then held for the flush and Save. */
const pick = async (kind: MediaKind, seed: number) => {
    const image = kind === 'cover'
    const captured = await captureMedia(
        fileBytes(image ? PNG : MP3, seed),
        { name: image ? `cover${seed}.png` : `clip${seed}.mp3`, type: '' },
        image ? 'image' : 'audio',
    )
    holdMedia({
        hash: captured.meta.hash,
        bytes: captured.source,
        type: captured.meta.type,
        filename: captured.meta.filename,
        kind,
    })
    return captured
}

const naming = (state: State, kind: 'cover' | 'preview', picked: Picked): State => ({
    ...state,
    levelInfo: { ...state.levelInfo, [kind]: picked.meta },
})

const begin = (page: Page, state: State) =>
    page.flusher.begin({
        id: testId(),
        docId: testId(),
        origin: 'import',
        state,
        operation: originOperation('import'),
        dirty: false,
    })

const contextOf = (page: Page): WorkerContext => ({
    core: page.core,
    test: true,
    emit: () => undefined,
})

test.beforeEach(() => {
    resetHeldMediaForTests()
})

test('capture sniffs an image by its magic numbers, and an audio file stays audio', async () => {
    assert.equal(sniffImageType(new Uint8Array(PNG)), 'image/png')
    assert.equal(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
    assert.equal(sniffImageType(new TextEncoder().encode('GIF89a')), 'image/gif')
    assert.equal(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp')
    assert.equal(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WAVE')), '')
    assert.equal(sniffImageType(new Uint8Array([1, 2, 3])), '')
    assert.equal(sniffImageType(new Uint8Array([1, 2, 3]), 'image/x-guess'), 'image/x-guess')
    const cover = await captureMedia(fileBytes(PNG, 1), { name: 'c.bin', type: '' }, 'image')
    assert.equal(cover.meta.type, 'image/png')
    const clip = await captureMedia(fileBytes(MP3, 1), { name: 'c.bin', type: '' })
    assert.equal(clip.meta.type, 'audio/mpeg')
})

test('a held cover and preview ride the flush that first names them, and read back after', async () => {
    const world = createWorld({ seed: 1 })
    const page = await openPage(world, world.tab('a'))
    const base = stateOf(goldenChart())
    begin(page, base)
    await page.flusher.flush()
    assert.equal(rows(world, 'media').size, 0)

    const cover = await pick('cover', 1)
    const preview = await pick('preview', 2)
    const named = naming(naming(base, 'cover', cover), 'preview', preview)
    page.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('picked-media', {}, 'Level info')) },
        named,
        true,
    )
    // The pick flushes at once and strictly, with both items in the batch.
    await page.flusher.flush()
    const batch = page.batches.at(-1)
    assert.equal(batch?.durability, 'strict')
    assert.deepEqual(
        batch?.media.map((item) => item.kind),
        ['cover', 'preview'],
    )
    const media = [...rows(world, 'media').values()]
    assert.equal(media.length, 2)
    const coverRow = media.find((row) => row.kind === 'cover')
    assert.equal(coverRow?.type, 'image/png')
    assert.equal(coverRow?.filename, 'cover1.png')
    const previewRow = media.find((row) => row.kind === 'preview')
    assert.equal(previewRow?.type, 'audio/mpeg')
    // The root names both, and storage is whole.
    const entries = [...rows(world, 'entries').values()]
    const root = rows(world, 'nodes').get(`x${toHex(entries.at(-1)?.snapshot as Uint8Array)}`)
    const refs = unpackHashes(root?.refs as Uint8Array).map(toHex)
    assert.ok(refs.includes(cover.meta.hash) && refs.includes(preview.meta.hash))
    assert.deepEqual(checkStored(world.memory), [])

    // After a reload nothing is held, and storage answers with the bytes, whole.
    resetHeldMediaForTests()
    assert.equal(heldItem(cover.meta.hash), undefined)
    const bytes = await page.tab.run(() => readMediaBytes(contextOf(page), cover.meta.hash))
    assert.deepEqual(new Uint8Array(bytes ?? new ArrayBuffer(0)), new Uint8Array(cover.source))

    // A later flush does not carry them again.
    page.flusher.append(
        { kind: 'edit', step: editStep(initialLife(named.initialLife, 900)) },
        { ...named, initialLife: 900 },
        true,
    )
    await page.flusher.flush()
    assert.equal(page.batches.at(-1)?.media.length, 0)
})

test('a cover the tab does not hold stores its metadata only', async () => {
    const world = createWorld({ seed: 2 })
    const page = await openPage(world, world.tab('a'))
    const cover = await pick('cover', 3)
    resetHeldMediaForTests()
    begin(page, naming(stateOf(goldenChart()), 'cover', cover))
    await page.flusher.flush()
    assert.deepEqual(page.errors, [])
    assert.equal(rows(world, 'media').size, 0)
    assert.equal(page.results.at(-1)?.kind, 'stored')
    assert.deepEqual(checkStored(world.memory), [])
})

test('a held cover is stored again when its row went missing, while this tab holds it', async () => {
    const world = createWorld({ seed: 3 })
    const page = await openPage(world, world.tab('a'))
    const cover = await pick('cover', 4)
    const named = naming(stateOf(goldenChart()), 'cover', cover)
    begin(page, named)
    await page.flusher.flush()
    const crossed = editStep(initialLife(named.initialLife, named.initialLife + 1))
    page.flusher.append(
        { kind: 'edit', step: crossed },
        { ...named, initialLife: named.initialLife + 1 },
        true,
    )
    await page.flusher.flush()
    const other = world.tab('other')
    const otherCore = workerCore(world, other)
    await other.run(() => otherCore.start())
    await other.run(() =>
        otherCore.write(['media', 'meta'], async (tx) => {
            await tx.delete('media', hashKey(fromHex16(cover.meta.hash)))
            await bumpEpoch(tx)
        }),
    )
    assert.equal(rows(world, 'media').size, 0)
    page.flusher.append({ kind: 'undo', step: crossed }, named, false)
    await page.flusher.flush()
    assert.equal(page.batches.at(-1)?.media[0]?.hash, cover.meta.hash)
    assert.equal(page.batches.at(-1)?.media[0]?.kind, 'cover')
    assert.equal(rows(world, 'media').size, 1)
})

test('only the item the state names is carried: a replaced cover is not', async () => {
    const world = createWorld({ seed: 4 })
    const page = await openPage(world, world.tab('a'))
    const first = await pick('cover', 5)
    const second = await pick('cover', 6)
    begin(page, naming(stateOf(goldenChart()), 'cover', second))
    await page.flusher.flush()
    assert.equal(rows(world, 'media').size, 1)
    assert.notEqual(first.meta.hash, second.meta.hash)
    assert.equal(page.batches.at(-1)?.media[0]?.hash, second.meta.hash)
})

test('a kill at every await of a flush with a picked cover stores the cover with its entry or not at all', async () => {
    const cover = await pick('cover', 7)
    const named = naming(stateOf(goldenChart()), 'cover', cover)
    const result = await crashSweep({
        seeds: [undefined, CI_SEEDS[0]],
        scenario: async ({ world, victim }) => {
            const page = await openPage(world, victim)
            begin(page, named)
            await page.flusher.flush()
        },
        check: ({ world }) => {
            assert.deepEqual(checkStored(world.memory), [])
            assert.equal(rows(world, 'media').size, rows(world, 'sessions').size)
        },
    })
    assert.ok(result.every(({ points }) => points > 10))
})
