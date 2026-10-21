import assert from 'node:assert/strict'
import test from 'node:test'
import { hashKey } from '../../../src/local/db'
import { fromHex16, toHex } from '../../../src/local/hash'
import { toRecords } from '../../../src/local/records/records'
import { packHashes } from '../../../src/local/records/rows'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import type { SaveStore } from '../../../src/local/save/bodies'
import { stillBad } from '../../../src/local/save/bodies'
import { buildSave } from '../../../src/local/save/execute'
import { readReplaceDecision, readSaveNeeds } from '../../../src/local/save/predicate'
import { repairFromSource } from '../../../src/local/save/repair'
import { nxspDiskState } from '../../../src/platform/fingerprint'
import { BGM, COVER, PREVIEW } from '../nxsp/helpers'
import { Fixture, heldRows, inspectNxsp, save, saveOptions, sourceOf, stateAt } from './fixture'

// A save picker returning the chain's own file (Part 1 §1.4.7 R2, R4; owner decision log D5;
// `work/d5/safety.md` S1, S2): the file is read first only when storage lacks what it holds (the
// Replace guard's test), and then appended to, so nothing is lost; with the read declined it is
// written from storage, and the write says "Some earlier Timeline steps were not kept.".

const diskOf = (file: File) => nxspDiskState(file, file.lastModified).then((disk) => ({ ...disk }))

const needsRead = async (fixture: Fixture, file: File) => {
    const disk = await nxspDiskState(file, file.lastModified)
    const { projectJson } = await inspectNxsp(file, {
        token: 'pick',
        role: 'target',
        fingerprint: disk.fingerprint,
    })
    return !!(
        await readReplaceDecision(fixture.store, fixture.chainId, projectJson, disk.fingerprint)
    )?.holdsBase
}

const chainWithFile = async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.edit(2)
    // Undone and replaced: state 2 leaves the stack, so cleanup can take it.
    fixture.undo()
    await fixture.edit(3)
    await fixture.flush()
    const first = await save(fixture, { kind: 'copy' }, { disk: diskOf })
    assert.ok(first.file)
    await fixture.edit(4)
    await fixture.flush()
    return { fixture, file: first.file }
}

test('storage holding everything: no read, and the self-pick written from storage loses nothing', async () => {
    const { fixture, file } = await chainWithFile()
    assert.equal(await needsRead(fixture, file), false)
    const { built, file: written } = await save(fixture, { kind: 'copy' }, { disk: diskOf })
    assert.ok(!('refused' in built) && written)
    assert.equal(built.stepsLine, 'none')
    const old = (await heldRows(file)).rows
    const now = (await heldRows(written)).rows
    for (const [row, count] of old) assert.ok((now.get(row) ?? 0) >= count, row)
})

test('storage short: the file is read first and appended to; declined, the line shows', async () => {
    const { fixture, file } = await chainWithFile()
    await fixture.flush()
    assert.ok(await fixture.thin(0, 2))
    assert.equal(await needsRead(fixture, file), true)

    // Read first: an append to the bytes read, every row of the file kept.
    const appended = await save(
        fixture,
        { kind: 'append', source: 'target' },
        { files: [await sourceOf(file)], disk: diskOf, binds: false },
    )
    assert.ok(!('refused' in appended.built) && appended.file)
    assert.equal(appended.built.stepsLine, 'none')
    const old = (await heldRows(file)).rows
    const now = (await heldRows(appended.file)).rows
    for (const [row, count] of old) assert.ok((now.get(row) ?? 0) >= count, row)

    // The read declined: written from storage, and the write says so.
    const declined = await save(fixture, { kind: 'copy' }, { disk: diskOf, binds: false })
    assert.ok(!('refused' in declined.built))
    assert.equal(declined.built.stepsLine, 'notKept')
})

test('whether to read the file first is known from storage alone: rows it lacks, or head media', async () => {
    const { fixture } = await chainWithFile()
    const missing = 'ff'.repeat(16)
    const full = await readSaveNeeds(fixture.store, fixture.chainId, [missing])
    assert.equal(full.carries, true)
    // Media the media store doesn't hold is lacking: the file may hold it.
    assert.deepEqual(full.lacking, [missing])
    assert.ok(await fixture.thin(0, 2))
    assert.equal((await readSaveNeeds(fixture.store, fixture.chainId, [])).carries, false)
})

/** Flips a byte of a stored chunk that only `k`'s state needs, as bit rot no build has found yet. */
const damageOnly = async (fixture: Fixture, k: number, others: number[]) => {
    const chunks = (n: number) => {
        const encoded = encodeSnapshot(toRecords(stateAt(n).state))
        return [encoded.header, ...encoded.chunks].map((chunk) => toHex(chunk.hash))
    }
    const shared = new Set(others.flatMap(chunks))
    const hex = chunks(k).find((each) => !shared.has(each))
    assert.ok(hex, `state ${k} has a chunk of its own`)
    const key = hashKey(fromHex16(hex))
    await fixture.store.write(['chunks'], async (tx) => {
        const row = (await tx.get('chunks', key)) as { bytes: Uint8Array }
        const bytes = row.bytes.slice()
        bytes[0] = (bytes[0] ?? 0) ^ 0x5a
        await tx.put('chunks', { ...row, bytes }, key)
    })
    return hex
}

test('damage no build has found: the self-pick is written from storage, the step kept: false and the line shown', async () => {
    // The property test's "edit, edit, save, edit, edit, damage, pick" (save-prop): the carry test
    // reads stored rows only, so it can't see a bad chunk, and the file isn't read (R2). The write
    // from storage finds the damage, marks the row and says so (§1.6.11.6; D5; H-2, H-3).
    const fixture = await Fixture.create()
    await fixture.start(1)
    await fixture.edit(2)
    await fixture.edit(3)
    await fixture.flush()
    const first = await save(fixture, { kind: 'copy' }, { disk: diskOf })
    const file = first.file
    assert.ok(file)
    await fixture.edit(4)
    await fixture.edit(5)
    await fixture.flush()
    const hex = await damageOnly(fixture, 1, [2, 3, 4, 5])
    assert.equal(await needsRead(fixture, file), false)
    const { built, file: written } = await save(fixture, { kind: 'copy' }, { disk: diskOf })
    assert.ok(!('refused' in built) && written)
    assert.deepEqual(built.damaged, [hex])
    assert.equal(built.marked, 1)
    assert.equal(built.stepsLine, 'notKept')
    const old = await heldRows(file)
    const now = await heldRows(written)
    const init = `init|${old.history.entries[0]?.time}|${stateAt(1).hex}`
    assert.equal(old.rows.get(init), 1)
    // The row is written, flagged: History shows it as damaged, never as a silent gap.
    assert.equal(now.rows.get(init), undefined)
    const row = now.history.entries.find((entry) => entry.kind === 'init')
    assert.equal(row?.kept, false)
    // Every other row of the picked file is kept with its state.
    for (const [key, count] of old.rows)
        if (key !== init) assert.ok((now.rows.get(key) ?? 0) >= count, key)
    // It writes its own id, so it claims nothing it lacks.
    const revision = now.read.project?.revision
    assert.equal(revision?.completeFrom, revision?.id)
    // The mark is stored (one-way), so no later write claims the step.
    const stored = (await fixture.entries()).find((entry) => entry.kind === 'init')
    assert.equal(stored?.kept, false)
})

/** Flips the first byte of a stored chunk: once makes it bad, twice makes it whole again. */
const flip = (fixture: Fixture, hex: string) =>
    fixture.store.write(['chunks'], async (tx) => {
        const key = hashKey(fromHex16(hex))
        const row = (await tx.get('chunks', key)) as { bytes: Uint8Array }
        const bytes = row.bytes.slice()
        bytes[0] = (bytes[0] ?? 0) ^ 0x5a
        await tx.put('chunks', { ...row, bytes }, key)
    })

test('damage storage knows of under a kept row the base held makes the next write short (SP-1)', async () => {
    // Bodies are shared between chains: another chain's build found the bad chunk and recorded it
    // in its `badChunks`, marking only its own rows. This chain's rows of that state stay kept, so
    // the carry test passes; the known damage makes the write short, and the file is read first.
    const { fixture, file } = await chainWithFile()
    const hex = await damageOnly(fixture, 3, [0, 1, 2, 4])
    await fixture.store.write(['chains'], (tx) =>
        tx.put('chains', {
            chainId: 'another',
            docId: 'another',
            lineageId: 'lineage',
            badChunks: packHashes([fromHex16(hex)]),
        }),
    )
    assert.equal(await needsRead(fixture, file), false)
    assert.equal((await readSaveNeeds(fixture.store, fixture.chainId, [])).carries, false)
    // Stored again whole, the hash is no longer short.
    await flip(fixture, hex)
    assert.equal((await readSaveNeeds(fixture.store, fixture.chainId, [])).carries, true)
})

test('a stored BGM a build found bad counts as lacking, so the file holding it is read first (SP-1)', async () => {
    const { fixture } = await chainWithFile()
    await fixture.storeMedia([BGM, COVER, PREVIEW])
    const key = hashKey(fromHex16(BGM.ref.hash))
    const row = (await fixture.store.read(['media'], (tx) => tx.get('media', key))) as {
        blob: Blob
    }
    const bytes = new Uint8Array(await row.blob.arrayBuffer())
    bytes[0] = (bytes[0] ?? 0) ^ 0x5a
    await fixture.store.write(['media'], (tx) =>
        tx.put('media', { ...row, blob: new Blob([bytes]) }, key),
    )
    // The key is there, so before any build it reads as held.
    assert.deepEqual(
        (await readSaveNeeds(fixture.store, fixture.chainId, [BGM.ref.hash])).lacking,
        [],
    )
    // A download finds it bad and records it.
    const download = await save(fixture, { kind: 'copy' }, { binds: false })
    assert.ok(!('refused' in download.built))
    assert.ok(download.built.damaged.includes(BGM.ref.hash))
    assert.deepEqual(
        (await readSaveNeeds(fixture.store, fixture.chainId, [BGM.ref.hash])).lacking,
        [BGM.ref.hash],
    )
})

/** The SP-1 case above: a chunk only state 3 needs gone bad, found by another chain's build. */
const knownToAnother = async () => {
    const { fixture, file } = await chainWithFile()
    const hex = await damageOnly(fixture, 3, [0, 1, 2, 4])
    await fixture.store.write(['chains'], (tx) =>
        tx.put('chains', {
            chainId: 'another',
            docId: 'another',
            lineageId: 'lineage',
            badChunks: packHashes([fromHex16(hex)]),
        }),
    )
    assert.equal((await readSaveNeeds(fixture.store, fixture.chainId, [])).carries, false)
    return { fixture, file, hex }
}

test('known damage the own file holds is put right by the append, so the next Save isn’t short (L1)', async () => {
    const { fixture, file, hex } = await knownToAnother()
    const appended = await save(
        fixture,
        { kind: 'append', source: 'target' },
        { files: [await sourceOf(file)], disk: diskOf },
    )
    assert.ok(!('refused' in appended.built) && appended.file)
    assert.deepEqual(appended.built.damaged, [])
    assert.equal(appended.built.stepsLine, 'none')
    // Stored again from the file's bytes, which hash to its key: no longer bad, and no longer short.
    assert.deepEqual([...(await stillBad(fixture.store, [hex]))], [])
    assert.equal((await readSaveNeeds(fixture.store, fixture.chainId, [])).carries, true)
    // A write from storage now finds nothing missing and keeps every step.
    const copy = await save(fixture, { kind: 'copy' }, { binds: false })
    assert.ok(!('refused' in copy.built))
    assert.deepEqual(copy.built.damaged, [])
    assert.equal(copy.built.marked, 0)
    // The label stays: `badChunks` is display only, never shrunk.
    const chain = (await fixture.store.read(['chains'], (tx) => tx.get('chains', 'another'))) as {
        badChunks: Uint8Array
    }
    assert.equal(chain.badChunks.length, 16)
})

test('a chunk in the file that doesn’t hash to its key is never stored (L1)', async () => {
    const { fixture, file, hex } = await knownToAnother()
    const source = await inspectNxsp(file, {
        token: 'target',
        role: 'target',
        fingerprint: (await sourceOf(file)).fingerprint,
    })
    const project = source.projectJson as { history: { chunks: string } }
    const entry = source.entries.find((each) => each.name === project.history.chunks)
    assert.ok(entry && entry.method === 0)
    const bytes = new Uint8Array(await file.arrayBuffer())
    for (let at = entry.dataOffset; at < entry.dataOffset + entry.uncompressedSize; at++)
        bytes[at] = (bytes[at] ?? 0) ^ 0x5a
    assert.deepEqual(await repairFromSource(fixture.store, source, new Blob([bytes])), [])
    assert.deepEqual([...(await stillBad(fixture.store, [hex]))], [hex])
    // The file itself puts it right.
    assert.deepEqual(await repairFromSource(fixture.store, source, file), [hex])
    assert.deepEqual([...(await stillBad(fixture.store, [hex]))], [])
})

test('a repair that fails leaves the Save as it was and the damage known (L1)', async () => {
    const { fixture, file, hex } = await knownToAnother()
    const failing: SaveStore = {
        read: fixture.store.read,
        write: (stores, fn, options) =>
            stores.includes('chunks')
                ? Promise.reject(new DOMException('Full', 'QuotaExceededError'))
                : fixture.store.write(stores, fn, options),
    }
    const files = [await sourceOf(file)]
    const target = { kind: 'append', source: 'target' } as const
    const made = saveOptions(fixture).options
    const options = { ...made, context: { ...made.context, newId: () => 'r-repair' } }
    const built = await buildSave(failing, fixture.chainId, target, options, files)
    assert.ok(!('refused' in built))
    assert.deepEqual(built.damaged, [])
    assert.equal(built.stepsLine, 'none')
    assert.deepEqual([...(await stillBad(fixture.store, [hex]))], [hex])
    assert.equal((await readSaveNeeds(fixture.store, fixture.chainId, [])).carries, false)
    // The same file as a build whose repair succeeds.
    const again = await buildSave(fixture.store, fixture.chainId, target, options, files)
    assert.ok(!('refused' in again))
    assert.deepEqual(
        new Uint8Array(await built.blob.arrayBuffer()),
        new Uint8Array(await again.blob.arrayBuffer()),
    )
    assert.deepEqual([...(await stillBad(fixture.store, [hex]))], [])
})

/** Records `hex` as found bad by another chain's build, as a body shared between chains. */
const knownBad = (fixture: Fixture, hexes: string[]) =>
    fixture.store.write(['chains'], (tx) =>
        tx.put('chains', {
            chainId: 'another',
            docId: 'another',
            lineageId: 'lineage',
            badChunks: packHashes(hexes.map(fromHex16)),
        }),
    )

/** Rewrites a stored root or node row so it no longer hashes to its key, as bit rot does. */
const rot = (fixture: Fixture, hex: string, change: (row: Record<string, unknown>) => void) =>
    fixture.store.write(['nodes'], async (tx) => {
        const key = hashKey(fromHex16(hex))
        const row = { ...((await tx.get('nodes', key)) as Record<string, unknown>) }
        change(row)
        await tx.put('nodes', row, key)
    })

test('a known-bad root and kind node the own file holds are put right by the append (SF2-3)', async () => {
    const { rootJsonFromRow } = await import('../../../src/local/records/rows')
    const { fixture, file } = await chainWithFile()
    const root = stateAt(3).hex
    const rootOf = async (k: number) =>
        rootJsonFromRow(
            (await fixture.store.read(['nodes'], (tx) =>
                tx.get('nodes', hashKey(fromHex16(stateAt(k).hex))),
            )) as never,
        )
    const others = new Set<string>()
    for (const k of [0, 1, 2, 4])
        for (const [, node] of (await rootOf(k))[2] as [string, string][]) others.add(node)
    const node = ((await rootOf(3))[2] as [string, string][])
        .map(([, each]) => each)
        .find((each) => !others.has(each))
    assert.ok(node, 'state 3 has a kind node of its own')
    await rot(fixture, node, (row) => {
        const refs = (row.refs as Uint8Array).slice()
        refs[0] = (refs[0] ?? 0) ^ 0x5a
        row.refs = refs
    })
    await rot(fixture, root, (row) => {
        row.noteCount = (row.noteCount as number) + 1
    })
    await knownBad(fixture, [root, node])
    assert.deepEqual([...(await stillBad(fixture.store, [root, node]))].sort(), [root, node].sort())
    assert.equal((await readSaveNeeds(fixture.store, fixture.chainId, [])).carries, false)

    const appended = await save(
        fixture,
        { kind: 'append', source: 'target' },
        { files: [await sourceOf(file)], disk: diskOf },
    )
    assert.ok(!('refused' in appended.built) && appended.file)
    // Stored again from the file's records, which hash to their keys: whole, and no longer short.
    assert.deepEqual([...(await stillBad(fixture.store, [root, node]))], [])
    assert.equal((await readSaveNeeds(fixture.store, fixture.chainId, [])).carries, true)
    // The root's row carries its header's media again, as an import stores it.
    const row = (await fixture.store.read(['nodes'], (tx) =>
        tx.get('nodes', hashKey(fromHex16(root))),
    )) as { refs: Uint8Array; kinds: string[] }
    assert.ok(row.refs.length > 16 * (1 + row.kinds.length))
    const copy = await save(fixture, { kind: 'copy' }, { binds: false })
    assert.ok(!('refused' in copy.built))
    assert.deepEqual(copy.built.damaged, [])
    assert.equal(copy.built.marked, 0)
})

test('a root is stored again only once everything it reaches is whole in storage (SF2-3)', async () => {
    const { fixture, file } = await chainWithFile()
    const root = stateAt(3).hex
    await rot(fixture, root, (row) => {
        row.noteCount = (row.noteCount as number) + 1
    })
    // One of its chunks is bad too, and the file doesn't give chunks back here: the root stays.
    const chunk = await damageOnly(fixture, 3, [0, 1, 2, 4])
    await knownBad(fixture, [root])
    const source = await inspectNxsp(file, {
        token: 'target',
        role: 'target',
        fingerprint: (await sourceOf(file)).fingerprint,
    })
    assert.deepEqual(await repairFromSource(fixture.store, source, file), [])
    assert.deepEqual([...(await stillBad(fixture.store, [root]))], [root])
    // Its chunk known bad too: put back first, then the root.
    await knownBad(fixture, [root, chunk])
    assert.deepEqual(
        (await repairFromSource(fixture.store, source, file)).sort(),
        [chunk, root].sort(),
    )
    assert.deepEqual([...(await stillBad(fixture.store, [root, chunk]))], [])
})

test('a known-bad stored BGM the own file holds is put right by the append (SF2-3)', async () => {
    const fixture = await Fixture.create()
    await fixture.storeMedia([BGM, COVER, PREVIEW])
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.flush()
    const first = await save(fixture, { kind: 'copy' }, { disk: diskOf })
    const file = first.file
    assert.ok(file)
    await fixture.edit(2)
    await fixture.flush()
    const key = hashKey(fromHex16(BGM.ref.hash))
    const row = (await fixture.store.read(['media'], (tx) => tx.get('media', key))) as {
        blob: Blob
    }
    const bytes = new Uint8Array(await row.blob.arrayBuffer())
    bytes[0] = (bytes[0] ?? 0) ^ 0x5a
    await fixture.store.write(['media'], (tx) =>
        tx.put('media', { ...row, blob: new Blob([bytes]) }, key),
    )
    // A download finds it bad and records it: every later dialog reads the file first.
    const download = await save(fixture, { kind: 'copy' }, { binds: false })
    assert.ok(!('refused' in download.built) && download.built.damaged.includes(BGM.ref.hash))
    assert.deepEqual(
        (await readSaveNeeds(fixture.store, fixture.chainId, [BGM.ref.hash])).lacking,
        [BGM.ref.hash],
    )
    const appended = await save(
        fixture,
        { kind: 'append', source: 'target' },
        { files: [await sourceOf(file)], disk: diskOf },
    )
    assert.ok(!('refused' in appended.built))
    // Stored again from the file's entry, which hashes to its `sha256`: no longer lacking.
    assert.deepEqual(
        (await readSaveNeeds(fixture.store, fixture.chainId, [BGM.ref.hash])).lacking,
        [],
    )
    const next = await save(fixture, { kind: 'copy' }, { binds: false })
    assert.ok(!('refused' in next.built))
    assert.ok(!next.built.damaged.includes(BGM.ref.hash))
})
