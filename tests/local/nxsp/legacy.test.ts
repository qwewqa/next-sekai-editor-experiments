import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
    executePlan,
    inspectNxsp,
    planNxsp,
    readNxsp,
    type BuildInput,
} from '../../../src/local/nxsp'
import { checkBuilt } from '../../../src/local/save/verify'
import { ZipReader } from '../../../src/zip'
import { chain, fixedChunks, REV_1, REV_2, secondInput } from './goldenChain'
import { memorySource } from './helpers'

const root = join(import.meta.dirname, 'legacy-test20f')
const pins = readFileSync(join(root, 'SHA256SUMS'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => line.split('  ') as [string, string])

test('the immutable pre-gzip corpus retains its bytes and opens fully in both readers', async () => {
    for (const [hash, name] of pins) {
        const bytes = readFileSync(join(root, name))
        assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, name)
        const read = await readNxsp(bytes)
        assert.ok(read.kind === 'nxsp', name)
        assert.equal(read.open, 'full', name)
        assert.deepEqual(read.report, [], name)
        assert.equal(read.project?.level, 'level.json')
        assert.equal(!!read.history, name !== 'no-history.nxsp')
        if (read.history) {
            assert.ok(read.history.undoStack.slots.length)
            assert.ok(read.history.roots.get(read.history.head))
        }
        if (name === 'full.nxsp')
            assert.deepEqual(Object.keys(read.media).sort(), ['bgm', 'cover', 'preview'])
        if (name === 'media-not-held.nxsp' || name === 'no-media.nxsp')
            assert.deepEqual(read.media, {})
        if (name === 'bgm-unticked.nxsp') assert.equal(read.project?.bgm, undefined)
    }
    const result = spawnSync(
        'uv',
        [
            'run',
            'python',
            '-I',
            'tools/nxsp_check.py',
            '--read',
            ...pins.map(([, name]) => join(root, name)),
        ],
        { encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    const reports = result.stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line))
    assert.equal(reports.length, pins.length)
    for (const read of reports) {
        assert.equal(read.kind, 'nxsp')
        assert.equal(read.open, 'full')
        assert.deepEqual(read.report, [])
    }
    const canonical = spawnSync(
        'uv',
        ['run', 'python', '-I', 'tools/nxsp_check.py', join(root, 'write-1.nxsp')],
        { encoding: 'utf8' },
    )
    assert.notEqual(canonical.status, 0)
    assert.match(canonical.stdout + canonical.stderr, /level.json.gz/)
})

test('legacy to gzip to gzip append preserves source history, media, ancestry and completeFrom', async () => {
    const legacy = new Blob([readFileSync(join(root, 'write-1.nxsp'))])
    const c = chain()
    const source = await inspectNxsp(legacy, {
        token: 'golden',
        role: 'target',
        fingerprint: 'zip:legacy',
    })
    const input = secondInput(c, fixedChunks(c.store), source.entries)
    const second = planNxsp(input, [source])
    const modern = await executePlan(
        second.plan,
        new Map([['golden', memorySource(legacy, 'zip:legacy')]]),
    )
    await checkBuilt(modern, second.storageChunks)
    const read = await readNxsp(modern)
    assert.ok(read.kind === 'nxsp' && read.open === 'full' && read.history)
    assert.equal(read.project?.revision?.completeFrom, REV_1)
    assert.ok(read.project?.revision?.ancestors.includes(REV_1))
    const modernSource = await inspectNxsp(modern, {
        token: 'second',
        role: 'target',
        fingerprint: 'zip:modern',
    })
    const revisionId = 'r003-0000-4000-8000-000000000000'
    const last = read.history.entries.at(-1)!
    const thirdInput: BuildInput = {
        ...input,
        context: { ...input.context, now: input.context.now + 10000, newId: () => revisionId },
        revision: {
            ...input.revision,
            parent: REV_2,
            n: 3,
            ancestors: [REV_2, REV_1],
            completeFrom: REV_1,
        },
        history: {
            append: 'second',
            entries: [{ ...last, time: last.time + 10000, revisionId }],
            roots: new Map(),
            nodes: new Map(),
            chunks: new Map(),
            undoStack: read.history.undoStack,
        },
        media: Object.fromEntries(
            Object.entries(read.media).map(([kind, media]) => [
                kind,
                {
                    copy: { source: 'second', entryIndex: media.entry.index },
                    sha256: media.form.sha256,
                    type: media.form.type,
                    filename: media.form.filename ?? '',
                },
            ]),
        ),
    }
    const third = planNxsp(thirdInput, [modernSource])
    const final = await executePlan(
        third.plan,
        new Map([['second', memorySource(modern, 'zip:modern')]]),
    )
    await checkBuilt(final, third.storageChunks)
    const finalRead = await readNxsp(final)
    assert.ok(finalRead.kind === 'nxsp' && finalRead.open === 'full' && finalRead.history)
    assert.equal(finalRead.project?.revision?.completeFrom, REV_1)
    assert.deepEqual(finalRead.project?.revision?.ancestors, [REV_2, REV_1])
    assert.deepEqual(
        finalRead.history.entries.slice(0, read.history.entries.length),
        read.history.entries,
    )
    assert.deepEqual(finalRead.history.undoStack, read.history.undoStack)
    for (const [before, after] of [
        [legacy, modern],
        [modern, final],
    ]) {
        const old = await ZipReader.open(before!)
        const next = await ZipReader.open(after!)
        for (const entry of old.entries.filter((entry) =>
            entry.name.startsWith('history/segments/'),
        )) {
            const copied = next.get(entry.name)!
            assert.equal(copied.method, entry.method)
            assert.deepEqual(
                await next.read(copied, { maxSize: 1 << 30 }),
                await old.read(entry, { maxSize: 1 << 30 }),
            )
        }
        const prefix = await old.read(old.get('history/chunks.bin')!, { maxSize: 1 << 30 })
        const chunks = await next.read(next.get('history/chunks.bin')!, { maxSize: 1 << 30 })
        assert.deepEqual(chunks.subarray(0, prefix.length), prefix)
    }
    for (const kind of ['bgm', 'cover'] as const)
        assert.deepEqual(
            await finalRead.media[kind]?.bytes.arrayBuffer(),
            await read.media[kind]?.bytes.arrayBuffer(),
        )
})
