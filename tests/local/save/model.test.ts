import assert from 'node:assert/strict'
import test from 'node:test'
import { hashKey } from '../../../src/local/db'
import { fromHex16, toHex } from '../../../src/local/hash'
import { PlanError } from '../../../src/local/nxsp/plan'
import { setSaveHooksForTests } from '../../../src/local/save/build'
import { setBuiltHookForTests } from '../../../src/local/save/execute'
import { ModelError, orderSessions } from '../../../src/local/save/model'
import { nxspDiskState } from '../../../src/platform/fingerprint'
import { unzip, zipItems } from '../nxsp/craft'
import { BGM } from '../nxsp/helpers'
import { checkFiles, Fixture, hasUv, heldRows, save, sourceOf, stateAt } from './fixture'

// The settled history model's exit items (Part 1 §1.11.6: "The history model", "completeFrom
// and the line", "Bodies from storage are verified", "What each write changes", "A long chain",
// "A re-zipped source") over chains in a test profile.

const diskOf = (file: File) => nxspDiskState(file, file.lastModified).then((disk) => ({ ...disk }))

const ok = <T extends object>(value: T) => {
    assert.ok(!('refused' in value), JSON.stringify(value))
    return value as Exclude<T, { refused: string }>
}

/** Multiset of written rows (kind, time, snapshot) with their kept flag, all rows. */
const allRows = async (file: Blob) => {
    const { history } = await heldRows(file)
    return history.entries.map((entry) => `${entry.kind}|${entry.time}|${entry.snapshot}`)
}

const bound = async () => {
    const fixture = await Fixture.create()
    await fixture.storeMedia()
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.flush()
    const first = await save(fixture, { kind: 'copy' }, { disk: diskOf })
    ok(first.built)
    assert.ok(first.file)
    return { fixture, file: first.file }
}

const writeBack = (fixture: Fixture, file: File) =>
    sourceOf(file).then((source) =>
        save(fixture, { kind: 'append', source: 'target' }, { files: [source], disk: diskOf }),
    )

test('the append assertion fails a plan whose prefix a hook altered, as a plan error', async () => {
    const { fixture, file } = await bound()
    await fixture.edit(2)
    await fixture.flush()
    setSaveHooksForTests({
        plan: (plan) => ({
            ...plan,
            entries: plan.entries.map((entry) =>
                entry.name === 'history/chunks.bin'
                    ? { ...entry, parts: entry.parts.filter((part) => part.kind === 'bytes') }
                    : entry,
            ),
        }),
    })
    try {
        const { built } = await writeBack(fixture, file)
        assert.ok('refused' in built)
        assert.equal(built.refused, 'plan')
        assert.match(built.message ?? '', /Not an append/)
    } finally {
        setSaveHooksForTests({})
    }
})

test('a reduced bound session saved to its file keeps the file’s full history', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    fixture.undo()
    await fixture.edit(2)
    await fixture.flush()
    const first = await save(fixture, { kind: 'copy' }, { disk: diskOf })
    ok(first.built)
    assert.ok(first.file)
    // Cleanup reduces a row the file holds; the append carries it from the file.
    assert.equal(await fixture.thin(0, 1), true)
    await fixture.edit(3)
    await fixture.flush()
    const { built, file } = await writeBack(fixture, first.file)
    assert.equal(ok(built).someStepsNotKept, false)
    assert.ok(file)
    const { rows } = await heldRows(file)
    const reduced = fixture.sessions[0]?.rows[1]
    assert.ok(reduced)
    assert.equal(rows.get(`edit|${reduced.time}|${toHex(reduced.snapshot)}`), 1)
})

test('a bound chain whose opening session was deleted writes back every row once', async () => {
    const { fixture, file } = await bound()
    await fixture.start()
    await fixture.edit(2)
    await fixture.flush()
    await fixture.start()
    await fixture.edit(3)
    await fixture.flush()
    await fixture.deleteSession(0)
    const before = await allRows(file)
    const { built, file: next } = await writeBack(fixture, file)
    ok(built)
    assert.ok(next)
    const after = await allRows(next)
    assert.deepEqual(after.slice(0, before.length), before)
    // Then each later session's rows, once, and the new save.
    const later = fixture.sessions.flatMap((session) =>
        session.rows
            .filter((row) => row.kind !== 'save')
            .map((row) => `${row.kind}|${row.time}|${toHex(row.snapshot)}`),
    )
    assert.deepEqual(after.slice(before.length, -1), later)
    assert.equal(after.at(-1)?.split('|')[0], 'save')
})

test('the cut’s own session deleted: a write-back still writes every row once', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.flush()
    await fixture.start()
    await fixture.edit(2)
    await fixture.flush()
    const first = await save(fixture, { kind: 'copy' }, { disk: diskOf })
    ok(first.built)
    assert.ok(first.file)
    await fixture.start()
    await fixture.edit(3)
    await fixture.flush()
    await fixture.deleteSession(0)
    await fixture.deleteSession(0)
    const before = await allRows(first.file)
    const { built, file } = await writeBack(fixture, first.file)
    ok(built)
    assert.ok(file)
    const after = await allRows(file)
    assert.deepEqual(after.slice(0, before.length), before)
    assert.equal(after.length, before.length + (fixture.sessions[0]?.rows.length ?? 0))
    if (hasUv) {
        const result = await checkFiles([first.file, file])
        assert.equal(result.status, 0, result.output)
    }
})

test('sessions sharing a start are ordered by their parent links, or the write fails', () => {
    const a = { id: 'a', chainId: 'c', startedAt: 5, lastSeq: 1 }
    const b = { id: 'b', chainId: 'c', startedAt: 5, lastSeq: 1, parent: { id: 'a', uptoSeq: 1 } }
    assert.deepEqual(
        orderSessions([b, a]).map((session) => session.id),
        ['a', 'b'],
    )
    const c = { id: 'c', chainId: 'c', startedAt: 5, lastSeq: 1 }
    assert.throws(() => orderSessions([a, c]), ModelError)
})

test('downloads carry the base’s completeFrom until a row the base held is reduced, once', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    fixture.undo()
    await fixture.edit(2)
    await fixture.flush()
    const download = () => save(fixture, { kind: 'copy' }, { event: 'downloaded' })
    const d1 = ok((await download()).built)
    const d2 = await download()
    const b2 = ok(d2.built)
    assert.equal(b2.someStepsNotKept, false)
    assert.equal(b2.identity.completeFrom, d1.revisionId)
    // A forced cleanup reduces a row the base held.
    assert.equal(await fixture.thin(0, 1), true)
    const d3 = await download()
    const b3 = ok(d3.built)
    assert.equal(b3.someStepsNotKept, true)
    assert.equal(b3.identity.completeFrom, b3.revisionId)
    assert.deepEqual(b3.identity.entry, { count: 7, notKept: 1 })
    const d4 = await download()
    const b4 = ok(d4.built)
    assert.equal(b4.someStepsNotKept, false)
    assert.equal(b4.identity.completeFrom, b3.revisionId)
    if (hasUv) {
        const files = [d2.file, d3.file, d4.file].filter((file): file is File => !!file)
        const result = await checkFiles(files)
        assert.equal(result.status, 0, result.output)
    }
})

test('a download that isn’t carried writes its own id, never its oldest ancestor', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    fixture.undo()
    await fixture.edit(2)
    await fixture.flush()
    ok((await save(fixture, { kind: 'copy' }, { event: 'downloaded' })).built)
    ok((await save(fixture, { kind: 'copy' }, { event: 'downloaded' })).built)
    assert.equal(await fixture.thin(0, 1), true)
    const built = ok((await save(fixture, { kind: 'copy' }, { event: 'downloaded' })).built)
    assert.equal(built.identity.completeFrom, built.revisionId)
    assert.equal(built.identity.revision.ancestors.length, 2)
})

test('past the 1,024-id cap a carried value that fell off is clamped to the last ancestor', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.flush()
    ok((await save(fixture, { kind: 'copy' }, { event: 'downloaded' })).built)
    const chain = await fixture.chain()
    const revision = chain.revision as { id: string; n: number; ancestors: string[] }
    const ancestors = Array.from({ length: 1024 }, (_, i) => `old-${i}`)
    // The base's completeFrom is an id no longer within reach of the next write's ancestors.
    await fixture.putChain({
        revision: { ...revision, ancestors },
        file: { ...(chain.file as object), completeFrom: 'old-1023' },
    })
    const built = ok((await save(fixture, { kind: 'copy' }, { event: 'downloaded' })).built)
    assert.equal(built.identity.revision.ancestors.length, 1024)
    assert.equal(built.identity.completeFrom, 'old-1022')
})

test('a chunk row corrupted in storage is marked damaged; the Save goes on with the line', async () => {
    const { fixture } = await bound()
    await fixture.edit(2)
    await fixture.flush()
    // Corrupt a chunk only state 1 has: its CRC fails.
    const only = await uniqueChunk(fixture, 1)
    await fixture.store.write(['chunks'], async (tx) => {
        const row = (await tx.get('chunks', hashKey(fromHex16(only)))) as { bytes: Uint8Array }
        const bytes = row.bytes.slice()
        bytes[0] = (bytes[0] ?? 0) ^ 0xff
        await tx.put('chunks', { ...row, bytes }, hashKey(fromHex16(only)))
    })
    const { built, file } = await save(fixture, { kind: 'copy' }, { event: 'downloaded' })
    const plan = ok(built)
    assert.ok(file)
    assert.equal(plan.someStepsNotKept, true)
    assert.ok(plan.damaged.includes(only))
    assert.ok(plan.marked >= 1)
    const stored = await fixture.entries()
    const editOne = stored.find(
        (row) => row.kind === 'edit' && toHex(row.snapshot) === stateAt(1).hex,
    )
    assert.equal(editOne?.kept, false)
    const chain = await fixture.chain()
    assert.ok(chain.badChunks instanceof Uint8Array)
    const { history } = await heldRows(file)
    const written = history.entries.find(
        (entry) => entry.snapshot === stateAt(1).hex && entry.kind === 'edit',
    )
    assert.equal(written?.kept, false)
})

test('a chunk row swapped with another valid row fails its key-bound CRC the same way', async () => {
    const { fixture } = await bound()
    await fixture.edit(2)
    await fixture.edit(3)
    await fixture.flush()
    const a = await uniqueChunk(fixture, 1)
    const b = await uniqueChunk(fixture, 2)
    await fixture.store.write(['chunks'], async (tx) => {
        const rowA = await tx.get('chunks', hashKey(fromHex16(a)))
        const rowB = await tx.get('chunks', hashKey(fromHex16(b)))
        await tx.put('chunks', rowB, hashKey(fromHex16(a)))
        await tx.put('chunks', rowA, hashKey(fromHex16(b)))
    })
    const plan = ok((await save(fixture, { kind: 'copy' }, { event: 'downloaded' })).built)
    assert.ok(plan.damaged.includes(a) && plan.damaged.includes(b))
})

test('a byte flipped in the built chunks.bin fails the post-build check; nothing is handed over', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.flush()
    setBuiltHookForTests({
        built: async (blob) => {
            const { items, modified } = await unzip(blob)
            const chunks = items.find((item) => item.name === 'history/chunks.bin')
            assert.ok(chunks)
            chunks.data[3] = (chunks.data[3] ?? 0) ^ 1
            return zipItems(items, modified)
        },
    })
    try {
        const { built } = await save(fixture, { kind: 'copy' }, { event: 'downloaded' })
        assert.ok('refused' in built)
        assert.equal(built.refused, 'check')
    } finally {
        setBuiltHookForTests({})
    }
})

test('Save to File… of a session with a damaged head refuses; nothing is written', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(5)
    await fixture.flush()
    const head = await uniqueChunk(fixture, 5)
    await fixture.store.write(['chunks'], (tx) => tx.delete('chunks', hashKey(fromHex16(head))))
    const { built } = await save(
        fixture,
        { kind: 'new', docId: 'doc-x', sessionId: fixture.session.id },
        { binds: false },
    )
    assert.ok('refused' in built)
    assert.equal(built.refused, 'unreadableHead')
})

test('a stored BGM gone bad is marked damaged; a write-back copies the file’s own bgm entry', async () => {
    const { fixture, file } = await bound()
    await fixture.edit(2)
    await fixture.flush()
    await fixture.store.write(['media'], async (tx) => {
        const key = hashKey(fromHex16(BGM.ref.hash))
        const row = (await tx.get('media', key)) as Record<string, unknown>
        await tx.put('media', { ...row, blob: new Blob(['not the BGM']) }, key)
    })
    const { built, file: next } = await writeBack(fixture, file)
    const plan = ok(built)
    assert.ok(next)
    assert.ok(plan.damaged.includes(BGM.ref.hash))
    assert.deepEqual(plan.without, [])
    const { read } = await heldRows(next)
    assert.equal(read.media.bgm?.form.sha256, BGM.sha256)
})

test('Save to File… changes nothing on the chain; a later write-back holds every row once', async () => {
    const { fixture, file } = await bound()
    await fixture.edit(2)
    await fixture.flush()
    const before = await fixture.chain()
    const copy = await save(
        fixture,
        { kind: 'new', docId: 'doc-copy', sessionId: fixture.session.id },
        { binds: false },
    )
    const plan = ok(copy.built)
    assert.equal(plan.identity.docId, 'doc-copy')
    assert.equal(plan.identity.revision.ancestors.length, 0)
    assert.deepEqual(await fixture.chain(), before)
    const { built, file: next } = await writeBack(fixture, file)
    ok(built)
    assert.ok(next)
    const rows = await allRows(next)
    assert.equal(new Set(rows).size, rows.length)
})

test('a re-zipped source (DEFLATE chunks.bin) appends through an inflate copy', async () => {
    const { fixture, file } = await bound()
    await fixture.edit(2)
    await fixture.flush()
    const { items, modified } = await unzip(file)
    for (const item of items) item.method = 'deflate'
    const rezipped = new File([await zipItems(items, modified)], 'coconut.nxsp', {
        lastModified: 5,
    })
    // The binding follows the re-zipped file, as an open of it would.
    const chain = await fixture.chain()
    await fixture.putChain({ file: { ...(chain.file as object), disk: await diskOf(rezipped) } })
    const { built, file: next } = await writeBack(fixture, rezipped)
    ok(built)
    assert.ok(next)
    const oldChunks = items.find((item) => item.name === 'history/chunks.bin')?.data
    assert.ok(oldChunks)
    const { items: written } = await unzip(next)
    const newChunks = written.find((item) => item.name === 'history/chunks.bin')?.data
    assert.deepEqual(newChunks?.subarray(0, oldChunks.length), oldChunks)
})

test('a write-back to a file not at the base is refused', async () => {
    const { fixture, file } = await bound()
    const other = new File([new Uint8Array(await file.arrayBuffer())], 'x', { lastModified: 1 })
    const chain = await fixture.chain()
    await fixture.putChain({
        file: {
            ...(chain.file as object),
            disk: { fingerprint: 'zip:1:1:00000000', size: 1, lastModified: 1 },
        },
    })
    const { built } = await writeBack(fixture, other)
    assert.ok('refused' in built)
    assert.equal(built.refused, 'notAtBase')
})

test('a plan error is a refusal the Save can show', () => {
    assert.ok(new PlanError('x') instanceof Error)
})

/** A chunk only state `k` reaches among the stored ones: by its kind nodes. */
const uniqueChunk = async (fixture: Fixture, k: number) => {
    const others = [0, 1, 2, 3, 5].filter((n) => n !== k).map((n) => stateAt(n).hex)
    const chunksOf = async (hex: string) => {
        const { nodeJsonFromRow, rootJsonFromRow } = await import('../../../src/local/records/rows')
        return fixture.store.read(['nodes'], async (tx) => {
            const root = await tx.get('nodes', hashKey(fromHex16(hex)))
            if (!root) return new Set<string>()
            const json = rootJsonFromRow(root as never)
            const out = new Set<string>([json[1] as string])
            for (const [, node] of json[2] as [string, string][]) {
                const row = await tx.get('nodes', hashKey(fromHex16(node)))
                const nodeJson = nodeJsonFromRow(row as never)
                for (const chunk of nodeJson[2] as string[]) out.add(chunk)
            }
            return out
        })
    }
    const mine = await chunksOf(stateAt(k).hex)
    for (const hex of others) for (const chunk of await chunksOf(hex)) mine.delete(chunk)
    const [found] = mine
    assert.ok(found, `state ${k} shares every chunk`)
    return found
}

test('a long chain is written in segments of 500, and a write-back copies them whole', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    for (let i = 0; i < 300; i++) {
        fixture.undo()
        fixture.redo()
    }
    await fixture.flush()
    const first = await save(fixture, { kind: 'copy' }, { disk: diskOf })
    ok(first.built)
    assert.ok(first.file)
    const old = await unzip(first.file)
    const segments = old.items.filter((item) => item.name.startsWith('history/segments/'))
    assert.equal(segments.length, 1)
    await fixture.edit(2)
    await fixture.flush()
    const { built, file } = await writeBack(fixture, first.file)
    ok(built)
    assert.ok(file)
    const written = await unzip(file)
    for (const segment of segments)
        assert.deepEqual(
            written.items.find((item) => item.name === segment.name)?.data,
            segment.data,
        )
    if (hasUv) {
        const result = await checkFiles([first.file, file])
        assert.equal(result.status, 0, result.output)
    }
})

test('Replace writes the chain’s chronology with `replaces`, and the line when not carried', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    fixture.undo()
    await fixture.edit(2)
    await fixture.flush()
    ok((await save(fixture, { kind: 'copy' }, { disk: diskOf })).built)
    assert.equal(await fixture.thin(0, 1), true)
    const { built, file } = await save(
        fixture,
        { kind: 'replace', replaces: 'theirs' },
        { disk: diskOf },
    )
    const plan = ok(built)
    assert.ok(file)
    assert.equal(plan.someStepsNotKept, true)
    const { read } = await heldRows(file)
    assert.equal(read.project?.revision?.replaces, 'theirs')
    assert.equal(read.project?.revision?.completeFrom, plan.revisionId)
})

test('an append that meets damage in the chain’s own file writes nothing and says so', async () => {
    const { fixture, file } = await bound()
    await fixture.edit(2)
    await fixture.flush()
    // A byte of chunks.bin's data goes bad; the central directory, and so `<cd>`, stay.
    const { ZipReader } = await import('../../../src/zip/reader')
    const reader = await ZipReader.open(file)
    const entry = reader.get('history/chunks.bin')
    assert.ok(entry)
    const bytes = new Uint8Array(await file.arrayBuffer())
    const at = entry.localOffset + 30 + entry.name.length + 1
    bytes[at] = (bytes[at] ?? 0) ^ 0xff
    const damaged = new File([bytes], file.name, { lastModified: file.lastModified })
    const { built } = await writeBack(fixture, damaged)
    assert.ok('refused' in built)
    assert.equal(built.refused, 'damagedSource')
})
