import assert from 'node:assert/strict'
import test from 'node:test'
import { hashKey } from '../../../src/local/db'
import { fromHex16, toHex } from '../../../src/local/hash'
import { BIND_STORES, recordOwnSave } from '../../../src/local/save/bind'
import type { SaveStore } from '../../../src/local/save/bodies'
import { buildSave } from '../../../src/local/save/execute'
import { nxspDiskState } from '../../../src/platform/fingerprint'
import {
    asFile,
    checkFiles,
    commit,
    Fixture,
    hasUv,
    heldRows,
    save,
    saveOptions,
    sourceOf,
    stateAt,
} from './fixture'

// The carry test (§1.6.11.6 as D25 settles it): flagged rows count only when no kept row up to
// the cut has their state; a binding is stored with its write's marks; and flagged rows' states
// are written when storage still holds them whole (H-2).

const ok = <T extends object>(value: T) => {
    assert.ok(!('refused' in value), JSON.stringify(value))
    return value as Exclude<T, { refused: string }>
}

type FixtureRow = Fixture['sessions'][number]['rows'][number]

/** Cleanup's flag alone: the row is stored `kept: false`, its bodies stay. */
const flag = async (fixture: Fixture, pick: (row: FixtureRow) => boolean) => {
    const rows = fixture.sessions
        .flatMap((session) => session.rows)
        .filter((row) => row.kept && pick(row))
    for (const row of rows) {
        row.kept = false
        await fixture.store.write(['entries'], async (tx) => {
            const stored = (await tx.get('entries', [row.sessionId, row.seq])) as Record<
                string,
                unknown
            >
            await tx.put('entries', { ...stored, kept: false })
        })
    }
    return rows.length
}

const download = (fixture: Fixture) => save(fixture, { kind: 'copy' }, { event: 'downloaded' })

test('a flagged row whose state a kept row shares shows the line at most once (M7)', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.edit(2)
    fixture.undo()
    await fixture.flush()
    const d0 = ok((await download(fixture)).built)
    // Cleanup flags the edit to state 1; the undo row back to state 1 keeps it.
    assert.equal(
        await flag(fixture, (row) => row.kind === 'edit' && toHex(row.snapshot) === stateAt(1).hex),
        1,
    )
    const lines: boolean[] = []
    let from = d0.identity.completeFrom
    for (let i = 0; i < 3; i++) {
        const d = ok((await download(fixture)).built)
        lines.push(d.stepsLine !== 'none')
        if (d.stepsLine === 'none') assert.equal(d.identity.completeFrom, from)
        from = d.identity.completeFrom
    }
    assert.ok(lines.filter(Boolean).length <= 1, JSON.stringify(lines))
    // Nothing was lost: no line at all.
    assert.deepEqual(lines, [false, false, false])
})

test('a flagged row whose state only the stack held never carries its base (no over-claim)', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.edit(2)
    fixture.undo()
    fixture.redo()
    await fixture.flush()
    const one = stateAt(1).hex
    await flag(fixture, (row) => toHex(row.snapshot) === one)
    const b = await download(fixture)
    ok(b.built)
    assert.ok(b.file)
    fixture.undo()
    await fixture.flush()
    await flag(fixture, (row) => toHex(row.snapshot) === one)
    fixture.undo()
    await fixture.edit(3)
    await fixture.flush()
    // State 1 left the stack: cleanup removes its root.
    await fixture.store.write(['nodes'], (tx) => tx.delete('nodes', hashKey(fromHex16(one))))
    const n = await download(fixture)
    const built = ok(n.built)
    assert.ok(n.file)
    const bRows = (await heldRows(b.file)).rows
    const nRows = (await heldRows(n.file)).rows
    const lost = [...bRows.keys()].filter((key) => !nRows.has(key))
    assert.ok(lost.length > 0)
    // N lacks rows B held with their states: it must not claim B's completeness.
    assert.notEqual(built.identity.completeFrom, ok(b.built).identity.completeFrom)
    assert.equal(built.stepsLine, 'notKept')
    if (hasUv) {
        const result = await checkFiles([b.file, n.file])
        assert.equal(result.status, 0, result.output)
    }
})

/** A store whose next write of `entries` fails, as when storing is paused mid-build. */
const pausedOnce = (store: SaveStore): SaveStore => {
    let failed = false
    return {
        read: store.read,
        write: (stores, fn, options) => {
            if (!failed && stores.includes('entries')) {
                failed = true
                return Promise.reject(new DOMException('Paused', 'QuotaExceededError'))
            }
            return store.write(stores, fn, options)
        },
    }
}

test('a binding is stored with its write’s marks, so a later reduction never carries (minor 7)', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.edit(2)
    fixture.undo()
    await fixture.edit(3)
    await fixture.flush()
    // A chunk only state 1 reaches goes bad: the build marks the edit to it.
    const chunk = await onlyChunk(fixture, 1)
    const row = (await fixture.store.read(['chunks'], (tx) =>
        tx.get('chunks', hashKey(fromHex16(chunk))),
    )) as { bytes: Uint8Array }
    await fixture.store.write(['chunks'], async (tx) => {
        const bytes = row.bytes.slice()
        bytes[0] = (bytes[0] ?? 0) ^ 0xff
        await tx.put('chunks', { ...row, bytes }, hashKey(fromHex16(chunk)))
    })
    const { options, reserved } = saveOptions(fixture)
    const d1 = ok(
        await buildSave(pausedOnce(fixture.store), fixture.chainId, { kind: 'copy' }, options),
    )
    assert.equal(d1.markStored, false)
    assert.ok(d1.identity.marks.length >= 1)
    // Storing resumes: the identity unit goes in with its marks.
    await commit(fixture, d1, reserved, options, { event: 'downloaded' })
    const stored = await fixture.entries()
    const edit1 = stored.find(
        (each) => each.kind === 'edit' && toHex(each.snapshot) === stateAt(1).hex,
    )
    assert.equal(edit1?.kept, false)
    // The damage is repaired, and cleanup reduces a row d1 held.
    await fixture.store.write(['chunks'], (tx) => tx.put('chunks', row, hashKey(fromHex16(chunk))))
    assert.equal(await fixture.thin(0, 2), true)
    const d2 = ok((await download(fixture)).built)
    assert.notEqual(d2.identity.completeFrom, d1.identity.completeFrom)
    // Flags and a thinned root can't be told from the flagged row d1's file already lacked: the
    // counts agree, so it is not known missing (I-18).
    assert.equal(d2.stepsLine, 'mayNotBeIncluded')
})

test('flagged rows’ states are written when storage still holds them whole (H-2, minor 8)', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.edit(2)
    fixture.undo()
    await fixture.edit(3)
    await fixture.flush()
    // State 2 is only on its edit row; cleanup flags it but keeps its bodies.
    await flag(fixture, (row) => toHex(row.snapshot) === stateAt(2).hex)
    const { built, file } = await download(fixture)
    ok(built)
    assert.ok(file)
    const { history } = await heldRows(file)
    const edit2 = history.entries.find((entry) => entry.snapshot === stateAt(2).hex)
    assert.equal(edit2?.kept, false)
    assert.ok(history.roots.has(stateAt(2).hex))
    // A flagged row whose root is gone is no damage: nothing is marked.
    assert.equal(await fixture.thin(0, 2), true)
    const next = ok((await download(fixture)).built)
    assert.deepEqual(next.damaged, [])
    assert.equal(next.marked, 0)
})

/** A chunk only state `k` reaches among the fixture's stored states. */
const onlyChunk = async (fixture: Fixture, k: number) => {
    const { nodeJsonFromRow, rootJsonFromRow } = await import('../../../src/local/records/rows')
    const chunksOf = (hex: string) =>
        fixture.store.read(['nodes'], async (tx) => {
            const root = await tx.get('nodes', hashKey(fromHex16(hex)))
            const out = new Set<string>()
            if (!root) return out
            const json = rootJsonFromRow(root as never)
            out.add(json[1] as string)
            for (const [, node] of json[2] as [string, string][]) {
                const nodeRow = await tx.get('nodes', hashKey(fromHex16(node)))
                for (const each of nodeJsonFromRow(nodeRow as never)[2] as string[]) out.add(each)
            }
            return out
        })
    const mine = await chunksOf(stateAt(k).hex)
    for (const n of [0, 1, 2, 3, 4, 5].filter((each) => each !== k))
        for (const each of await chunksOf(stateAt(n).hex)) mine.delete(each)
    const [found] = mine
    assert.ok(found, `state ${k} shares every chunk`)
    return found
}

test('a Save without History reads only the head: a bad state elsewhere on the stack marks nothing (SF-7)', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.edit(2)
    // State 2 stays on the stack as the redo slot; the head is state 1.
    fixture.undo()
    await fixture.flush()
    const chunk = await onlyChunk(fixture, 2)
    assert.ok(chunk)
    const row = (await fixture.store.read(['chunks'], (tx) =>
        tx.get('chunks', hashKey(fromHex16(chunk))),
    )) as { bytes: Uint8Array }
    await fixture.store.write(['chunks'], async (tx) => {
        const bytes = row.bytes.slice()
        bytes[0] = (bytes[0] ?? 0) ^ 0xff
        await tx.put('chunks', { ...row, bytes }, hashKey(fromHex16(chunk)))
    })
    const bare = ok(
        (await save(fixture, { kind: 'copy' }, { binds: false, extra: { history: false } })).built,
    )
    assert.deepEqual(bare.damaged, [])
    assert.equal(bare.marked, 0)
    // With History the state is written, so its damage is found and marked.
    const full = ok((await save(fixture, { kind: 'copy' }, { binds: false })).built)
    assert.ok(full.damaged.length > 0)
})

// ADV3-1: our own completed Save recognised later, its `save` row not written (a kept gap below
// it), keeps its cut as the file holds it. The next write that isn't an append then doesn't carry
// the file's `completeFrom`, which would claim the `save` row the chain lacks: it shows the line.
test('a recognised Save whose row the chain lacks is never carried by the next copy (ADV3-1)', async () => {
    const fixture = await Fixture.create(71)
    await fixture.storeMedia()
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.flush()
    // A Save A whose seq 3 is a kept gap (its file may hold it), then Save B at 4.
    fixture.reserveSave()
    const { options, reserved } = saveOptions(fixture)
    assert.equal(reserved.seq, 4)
    const built = ok(await buildSave(fixture.store, fixture.chainId, { kind: 'copy' }, options, []))
    const b = await heldRows(asFile(built.blob))
    assert.ok(b.history.entries.some((entry) => entry.kind === 'save'))
    assert.equal(built.identity.entry!.count, b.history.entries.length)

    // A later visit recognises B: not this tab's session and `lastSeq` 2 < 3, so no row.
    const unit = {
        docId: built.identity.docId,
        revision: built.identity.revision,
        file: {
            name: 'coconut.nxsp',
            event: 'saved',
            at: reserved.time,
            hash: fromHex16(built.saveEntry.snapshot),
            entry: {
                sessionId: reserved.sessionId,
                seq: reserved.seq,
                startedAt: reserved.startedAt,
                ...built.identity.entry!,
            },
            ...(built.identity.completeFrom === undefined
                ? {}
                : { completeFrom: built.identity.completeFrom }),
        },
        marks: built.identity.marks,
        from: {},
    }
    assert.equal(
        await fixture.store.write(BIND_STORES, (tx) =>
            recordOwnSave(tx, {
                chainId: fixture.chainId,
                writer: { sessionId: reserved.sessionId },
                unit,
            }),
        ),
        'recorded',
    )
    assert.ok((await fixture.entries()).every((row) => row.kind !== 'save'))
    const cut = ((await fixture.chain()).file as { entry: { count: number } }).entry
    assert.equal(cut.count, b.history.entries.length)

    const next = saveOptions(fixture)
    const builtN = ok(
        await buildSave(fixture.store, fixture.chainId, { kind: 'copy' }, next.options),
    )
    const n = await heldRows(asFile(builtN.blob))
    const nRevision = n.read.project!.revision!
    const bRevision = b.read.project!.revision!
    const missing = [...b.rows].filter(([row, c]) => (n.rows.get(row) ?? 0) < c)
    assert.ok(missing.length > 0)
    const claimsB =
        nRevision.completeFrom === bRevision.id ||
        bRevision.ancestors.includes(nRevision.completeFrom!)
    assert.equal(claimsB, false)
    assert.equal(builtN.stepsLine, 'mayNotBeIncluded')
})

// A write that appends onto a base whose own row the chain lacks leaves an inexact cut (spec A,
// I-18): no later write carries from it, and its line says steps may not be included. A base whose
// session is gone stays exact: its count already shows the loss.
for (const lost of ['absent', 'replaced', 'sessionGone'] as const)
    test(`an append over a base whose own row is ${lost} ${lost === 'sessionGone' ? 'stays exact' : 'leaves an inexact cut'}`, async () => {
        const fixture = await Fixture.create(80)
        await fixture.storeMedia()
        await fixture.start(0)
        await fixture.edit(1)
        await fixture.flush()
        const diskOf = (file: File) =>
            nxspDiskState(file, file.lastModified).then((disk) => ({ ...disk }))
        const first = await save(fixture, { kind: 'copy' }, { disk: diskOf })
        assert.ok(first.file)
        const owner = fixture.session
        const own = owner.rows.find((row) => row.kind === 'save')!
        if (lost === 'sessionGone') {
            // A later visit holds the chain's head; the session of the cut is deleted.
            await fixture.start()
            await fixture.flush()
            await fixture.deleteSession(0)
        } else if (lost === 'absent') {
            owner.rows.splice(owner.rows.indexOf(own), 1)
            await fixture.store.write(['entries'], (tx) =>
                tx.delete('entries', [own.sessionId, own.seq]),
            )
        } else {
            // Another Save's row at the same place (the stored row, not the flush's copy).
            own.revisionId = 'another-save'
            await fixture.store.write(['entries'], async (tx) => {
                const stored = (await tx.get('entries', [own.sessionId, own.seq])) as object
                await tx.put('entries', { ...stored, revisionId: 'another-save' })
            })
        }
        const appended = await save(
            fixture,
            { kind: 'append', source: 'target' },
            { files: [await sourceOf(first.file)], disk: diskOf },
        )
        assert.ok(!('refused' in appended.built) && appended.file)
        assert.equal(
            appended.built.identity.entry?.inexact,
            lost === 'sessionGone' ? undefined : true,
        )
        // The next write that isn't an append never carries from an inexact cut.
        const copy = await save(fixture, { kind: 'copy' }, { binds: false })
        assert.ok(!('refused' in copy.built))
        if (lost === 'sessionGone') return
        assert.equal(copy.built.stepsLine, 'mayNotBeIncluded')
        assert.notEqual(copy.built.identity.completeFrom, first.built.identity.completeFrom)
        // And an append onto it stays inexact.
        const again = await save(
            fixture,
            { kind: 'append', source: 'target' },
            { files: [await sourceOf(appended.file)], disk: diskOf },
        )
        assert.ok(!('refused' in again.built))
        assert.equal(again.built.identity.entry?.inexact, true)
    })
