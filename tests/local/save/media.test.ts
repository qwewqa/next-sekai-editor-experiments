import assert from 'node:assert/strict'
import test from 'node:test'
import { Inflate } from 'pako'
import { captureEntryDescription } from '../../../src/history/operations'
import { headInput, pendingInput } from '../../../src/local/save/pending'
import { editStep, futureFixtureOperation, noteAdd } from '../../helpers/historySteps'
import { BGM, BGM_2, COVER, PREVIEW } from '../nxsp/helpers'
import { Fixture, heldRows, save, SECOND, stateAt } from './fixture'

// The media rule, this tab's pending records as the
// build's first source, and a download that inflates no chunk taken from storage.

const ok = <T extends object>(value: T) => {
    assert.ok(!('refused' in value), JSON.stringify(value))
    return value as Exclude<T, { refused: string }>
}

const chain = async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1, noteAdd(1))
    await fixture.flush()
    return fixture
}

test('media not held is written as metadata only, with each item named for its line', async () => {
    const fixture = await chain()
    const { built, file } = await save(fixture, { kind: 'copy' }, { event: 'downloaded' })
    const plan = ok(built)
    assert.ok(file)
    assert.deepEqual(plan.without, ['bgm', 'cover', 'preview'])
    assert.deepEqual(plan.tooLarge, [])
    const { read } = await heldRows(file)
    assert.equal(read.open, 'full')
    const bgm = read.project?.bgm
    assert.ok(bgm && bgm.file === undefined)
    assert.equal(bgm.hash, BGM.ref.hash)
    assert.equal('sha256' in bgm, false)
})

test('a held BGM over the 1 GB media cap is metadata only, named too large rather than not loaded', async () => {
    const fixture = await chain()
    await fixture.storeMedia([BGM, COVER, PREVIEW])
    const head = headInput(stateAt(1).state)
    assert.ok(head.bgm)
    const huge = { ...head, bgm: { ...head.bgm, size: 2 ** 31 } }
    const { built, file } = await save(
        fixture,
        { kind: 'copy' },
        { event: 'downloaded', extra: { head: huge } },
    )
    const plan = ok(built)
    assert.ok(file)
    assert.deepEqual(plan.without, ['bgm'])
    assert.deepEqual(plan.tooLarge, ['bgm'])
    const { read } = await heldRows(file)
    assert.equal(read.project?.bgm?.file, undefined)
})

test('held media are written with their bytes; BGM unticked leaves the BGM out', async () => {
    const fixture = await chain()
    await fixture.storeMedia([BGM, COVER])
    const { built, file } = await save(
        fixture,
        { kind: 'copy' },
        { event: 'downloaded', extra: { bgm: false } },
    )
    const plan = ok(built)
    assert.ok(file)
    assert.deepEqual(plan.without, ['preview'])
    const { read } = await heldRows(file)
    assert.equal(read.project?.bgm, undefined)
    assert.equal(read.media.cover?.form.sha256, COVER.sha256)
})

test("a tab's copy of the head's media is used when storage lacks it", async () => {
    const fixture = await chain()
    const { built, file } = await save(
        fixture,
        { kind: 'copy' },
        {
            event: 'downloaded',
            extra: {
                media: [BGM, PREVIEW].map((item) => ({
                    hash: item.ref.hash,
                    bytes: item.bytes,
                    type: item.ref.type,
                })),
            },
        },
    )
    assert.deepEqual(ok(built).without, ['cover'])
    assert.ok(file)
    const { read } = await heldRows(file)
    assert.equal(read.media.bgm?.form.sha256, BGM.sha256)
})

test('after Undo across a BGM change, the file holds the undone-to BGM and never the later one', async () => {
    const fixture = await chain()
    await fixture.storeMedia([BGM, BGM_2, COVER, PREVIEW])
    await fixture.edit(
        SECOND + 2,
        futureFixtureOperation('media-replacement', {}, 'Changed media and notes'),
    )
    fixture.undo()
    await fixture.flush()
    const { file } = await save(fixture, { kind: 'copy' }, { event: 'downloaded' })
    assert.ok(file)
    const { read } = await heldRows(file)
    assert.equal(read.media.bgm?.form.sha256, BGM.sha256)
    assert.equal(
        Object.keys(read.media).length,
        3,
        "only the head's BGM, cover and preview are written",
    )
})

test("this tab's unflushed rows, stack and records are the build's first source", async () => {
    const fixture = await chain()
    const head = stateAt(4).state
    const session = fixture.session
    const unstoredStep = editStep(noteAdd(3))
    const pending = pendingInput(
        [
            {
                seq: session.nextSeq++,
                time: 9_000_000,
                kind: 'edit',
                step: unstoredStep,
                state: head,
                dirty: true,
            },
        ],
        {
            base: 0,
            slots: [
                { state: stateAt(0).state, step: session.slots[0]!.step },
                { state: stateAt(1).state, step: session.slots[1]!.step },
                { state: head, step: unstoredStep },
            ],
            index: 2,
        },
    )
    const { built, file } = await save(
        fixture,
        { kind: 'copy' },
        { event: 'downloaded', extra: { pending, head: headInput(head) } },
    )
    const plan = ok(built)
    assert.ok(file)
    assert.equal(plan.saveEntry.snapshot, stateAt(4).hex)
    const { history, read } = await heldRows(file)
    assert.equal(read.open, 'full')
    assert.deepEqual(history.entries.map(captureEntryDescription), [
        captureEntryDescription(session.rows[0]),
        captureEntryDescription(session.rows[1]),
        { kind: 'edit', step: unstoredStep },
        captureEntryDescription(plan.saveEntry),
    ])
    assert.equal(history.head, stateAt(4).hex)
})

test('a download with the head given inflates no chunk taken from storage', async () => {
    const fixture = await chain()
    for (let k = 2; k < 12; k++) await fixture.edit(k, noteAdd(1))
    await fixture.flush()
    const stored = new Set<string>()
    await fixture.store.read(['chunks'], async (tx) => {
        for (const row of (await tx.getAll('chunks')) as { bytes: Uint8Array }[])
            stored.add(Buffer.from(row.bytes).toString('base64'))
    })
    const push = Inflate.prototype.push
    let inflated = 0
    Inflate.prototype.push = function (data, mode) {
        if (data instanceof Uint8Array && stored.has(Buffer.from(data).toString('base64')))
            inflated++
        return push.call(this, data, mode)
    }
    try {
        const { built } = await save(
            fixture,
            { kind: 'copy' },
            { event: 'downloaded', extra: { head: headInput(stateAt(11).state) } },
        )
        ok(built)
        assert.equal(inflated, 0)
        // The hook sees them: decoding the head from storage inflates its chunks.
        ok((await save(fixture, { kind: 'copy' }, { event: 'downloaded' })).built)
        assert.ok(inflated > 0)
    } finally {
        Inflate.prototype.push = push
    }
})
