import assert from 'node:assert/strict'
import test from 'node:test'
import { executePlan, planNxsp, type PinnedSource as PlanSource } from '../../src/local/nxsp'
import { inspectNxsp } from '../../src/local/nxsp/inspect'
import { nxspDiskState, sameContent } from '../../src/platform/fingerprint'
import { createMockPlatform, MockCrash } from '../../src/platform/mock'
import { FileError, type FileBody, type PinnedSource } from '../../src/platform/types'
import { platform } from '../../src/platform/web'
import { fresh } from '../local/nxsp/chain'
import { memorySource } from '../local/nxsp/helpers'
import { installFakeBrowser } from './fakeBrowser'

// Writing `.nxsp` files on the web and in the mock (Part 0 §0.9.1, §0.9.6): the revision id and
// `<cd>` as the precondition, the File pinned at the check as the only source of the old bytes,
// the check again just before close(), and the mock's faults.

installFakeBrowser()

const built = async () => {
    const { input } = fresh()
    const { plan } = planNxsp(input)
    return executePlan(plan, new Map())
}

/** A file built from the shared chain with a second revision appended: a plan over `source`. */
const appendPlan = async (source: PinnedSource): Promise<FileBody> => {
    const { input } = fresh()
    const pinned: PlanSource = await inspectNxsp(source.file, {
        token: source.token,
        role: source.role,
        fingerprint: source.disk.fingerprint,
    })
    const { plan } = planNxsp(
        {
            ...input,
            context: { ...input.context, newId: () => 'r900-0000-4000-8000-000000000000' },
            media: {},
            levelInfo: { ...input.levelInfo, cover: undefined, preview: undefined },
            history: undefined,
        },
        [pinned],
    )
    return { kind: 'zip', plan }
}

/** A handle over one file whose time and content a test sets. */
const fileHandle = (initial: Blob | undefined, events: string[] = []) => {
    let content = initial
    let time = 1000
    const handle = {
        name: 'coconut.nxsp',
        requestPermission: () => Promise.resolve('granted' as PermissionState),
        isSameEntry: (other: unknown) => Promise.resolve(other === handle),
        getFile: () =>
            content
                ? Promise.resolve(new File([content], 'coconut.nxsp', { lastModified: time }))
                : Promise.reject(new DOMException('Not found', 'NotFoundError')),
        set: (blob: Blob | undefined, at = time + 1000) => {
            content = blob
            time = at
        },
        createWritable: () => {
            const parts: Blob[] = []
            return Promise.resolve({
                write: (blob: Blob) => {
                    parts.push(blob)
                    events.push('write')
                    return Promise.resolve()
                },
                close: () => {
                    events.push('close')
                    content = new Blob(parts)
                    time += 1000
                    return Promise.resolve()
                },
                abort: () => {
                    events.push('abort')
                    return Promise.resolve()
                },
            })
        },
    }
    return handle as unknown as FileSystemFileHandle & {
        set: (blob: Blob | undefined, at?: number) => void
    }
}

const bytes = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer())

const flip = (data: Uint8Array, at: number) => {
    data[at] = (data[at] ?? 0) ^ 0xff
}

test('a .nxsp’s disk state is its revision id and <cd>; anything else is damaged', async () => {
    const file = await built()
    const disk = await nxspDiskState(file, 1234.7)
    assert.equal(disk.revisionId, 'r001-0000-4000-8000-000000000000')
    assert.match(disk.fingerprint, new RegExp(`^zip:${file.size}:1234:[0-9a-f]{8}$`))
    assert.deepEqual(await nxspDiskState(new Blob([]), 5), {
        fingerprint: 'damaged:0:5',
        size: 0,
        lastModified: 5,
    })
    const truncated = file.slice(0, file.size - 10)
    assert.equal((await nxspDiskState(truncated, 5)).fingerprint, `damaged:${truncated.size}:5`)
    // The same bytes at another time are the same content; a changed byte is not.
    assert.equal(sameContent(disk, await nxspDiskState(file, 99_999)), true)
    const changed = await bytes(file)
    flip(changed, changed.length - 30)
    assert.equal(sameContent(disk, await nxspDiskState(new Blob([changed]), 1234)), false)
})

test('a write-back appends through the File pinned at the check, then reads back', async () => {
    const events: string[] = []
    const original = await built()
    const handle = fileHandle(original, events)
    const expected = await nxspDiskState(original, 1000)
    let seen: PinnedSource[] = []
    const result = await platform.saveFile({
        kind: 'nxsp',
        suggestedName: 'coconut.nxsp',
        target: { kind: 'handle', handle },
        expected,
        build: (sources) => {
            seen = sources
            return appendPlan(sources[0]!)
        },
    })
    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.token, 'target')
    assert.deepEqual(seen[0]?.disk, expected)
    assert.equal(result.status, 'saved')
    const written = await handle.getFile()
    assert.ok(result.status === 'saved' && result.disk)
    assert.equal(result.disk.revisionId, 'r900-0000-4000-8000-000000000000')
    assert.deepEqual(result.disk, await nxspDiskState(written, written.lastModified))
    assert.deepEqual(events, ['write', 'close'])
})

test('the same bytes touched with a new time write back without a conflict', async () => {
    const original = await built()
    const handle = fileHandle(original)
    const expected = await nxspDiskState(original, 1000)
    handle.set(new Blob([await bytes(original)]), 50_000)
    const result = await platform.saveFile({
        kind: 'nxsp',
        suggestedName: 'coconut.nxsp',
        target: { kind: 'handle', handle },
        expected,
        build: (sources) => appendPlan(sources[0]!),
    })
    assert.equal(result.status, 'saved')
})

test('a file rewritten with the same size and time is a conflict, found by its <cd>', async () => {
    const original = await built()
    const handle = fileHandle(original)
    const expected = await nxspDiskState(original, 1000)
    const changed = await bytes(original)
    // A byte of the central directory's CRC field, so size and time stay the same.
    flip(changed, changed.length - 22 - 46 + 16)
    handle.set(new Blob([changed]), 1000)
    await assert.rejects(
        platform.saveFile({
            kind: 'nxsp',
            suggestedName: 'coconut.nxsp',
            target: { kind: 'handle', handle },
            expected,
            build: () => Promise.reject(new Error('never built')),
        }),
        (error: unknown) => error instanceof FileError && error.code === 'conflict',
    )
    assert.deepEqual(await bytes(await handle.getFile()), changed)
})

test('a file replaced during the build is a conflict, and nothing is written', async () => {
    const events: string[] = []
    const original = await built()
    const handle = fileHandle(original, events)
    const other = await built()
    await assert.rejects(
        platform.saveFile({
            kind: 'nxsp',
            suggestedName: 'coconut.nxsp',
            target: { kind: 'handle', handle },
            expected: await nxspDiskState(original, 1000),
            build: async (sources) => {
                const body = await appendPlan(sources[0]!)
                handle.set(new Blob([await bytes(other), new Uint8Array([0])]))
                return body
            },
        }),
        { code: 'conflict' },
    )
    assert.deepEqual(events, ['write', 'abort'])
})

test('a file replaced after the write and before close() is aborted, byte-identical', async () => {
    const events: string[] = []
    const original = await built()
    const replacement = new Blob([await bytes(original), new Uint8Array([7])])
    const handle = fileHandle(original, events)
    const expected = await nxspDiskState(original, 1000)
    const write = platform.saveFile({
        kind: 'nxsp',
        suggestedName: 'coconut.nxsp',
        target: { kind: 'handle', handle },
        expected,
        build: async (sources) => {
            const body = await appendPlan(sources[0]!)
            // Replaced once the build is done: the check before close() still sees it.
            queueMicrotask(() => {
                handle.set(replacement)
            })
            return body
        },
    })
    await assert.rejects(write, { code: 'conflict' })
    assert.deepEqual(events.at(-1), 'abort')
    assert.deepEqual(await bytes(await handle.getFile()), await bytes(replacement))
})

test('the mock pins the File at the check: a read after a change fails as a conflict', async () => {
    const mock = createMockPlatform()
    const handle = mock.createHandle('coconut.nxsp')
    mock.writeFile('coconut.nxsp', await built())
    const target = { kind: 'handle', handle } as const
    const expected = await mock.inspect(target, 'nxsp')
    assert.ok(expected !== 'missing')
    assert.equal(expected.revisionId, 'r001-0000-4000-8000-000000000000')
    const before = await bytes(mock.files.get('coconut.nxsp')!)
    await assert.rejects(
        mock.saveFile({
            kind: 'nxsp',
            suggestedName: 'coconut.nxsp',
            target,
            expected,
            build: async (sources) => {
                // Another program rewrites the file while the build reads it.
                mock.writeFile('coconut.nxsp', new Blob([before]))
                return appendPlan(sources[0]!)
            },
        }),
        (error: unknown) => error instanceof FileError && error.code === 'conflict',
    )
    assert.deepEqual(await bytes(mock.files.get('coconut.nxsp')!), before)
})

test('the mock’s faults: a crash before close() writes nothing; a change at close() is a conflict', async () => {
    const mock = createMockPlatform()
    const handle = mock.createHandle('coconut.nxsp')
    const original = await built()
    mock.writeFile('coconut.nxsp', original)
    const target = { kind: 'handle', handle } as const
    const expected = await mock.inspect(target, 'nxsp')
    assert.ok(expected !== 'missing')
    const request = {
        kind: 'nxsp' as const,
        suggestedName: 'coconut.nxsp',
        target,
        expected,
        build: (sources: PinnedSource[]) => appendPlan(sources[0]!),
    }

    mock.fault = (point) => {
        if (point === 'beforeClose') throw new MockCrash('killed')
    }
    await assert.rejects(mock.saveFile(request), MockCrash)
    assert.deepEqual(await bytes(mock.files.get('coconut.nxsp')!), await bytes(original))

    // The same bytes touched at the pre-close check: the whole fingerprint changed.
    mock.fault = (point, name) => {
        if (point === 'built') mock.writeFile(name, new Blob([original]))
    }
    await assert.rejects(mock.saveFile(request), { code: 'conflict' })

    mock.fault = (point) => {
        if (point === 'checked') throw new FileError('not-local', 'A placeholder')
    }
    await assert.rejects(mock.saveFile(request), { code: 'not-local' })

    mock.fault = undefined
    const touched = await mock.inspect(target, 'nxsp')
    assert.ok(touched !== 'missing')
    const result = await mock.saveFile({ ...request, expected: touched })
    assert.equal(result.status, 'saved')
    assert.ok(result.status === 'saved')
    assert.equal(result.disk?.revisionId, 'r900-0000-4000-8000-000000000000')
})

test('a plan whose copy fails with the source unchanged is damage, not a conflict', async () => {
    const original = await built()
    const source = memorySource(original)
    const pinned = await inspectNxsp(original, {
        token: 't',
        role: 'target',
        fingerprint: 'zip:test',
    })
    // A copy of level.json with a CRC that isn't the source's.
    const level = pinned.entries.find((entry) => entry.name === 'level.json')!
    const plan = {
        modified: { dosTime: 0, dosDate: 33 },
        entries: [
            {
                name: 'x',
                method: level.method,
                parts: [
                    {
                        kind: 'copy' as const,
                        source: 't',
                        entryIndex: level.index,
                        dataOffset: level.dataOffset,
                        check: { kind: 'entryCrc' as const },
                    },
                ],
                crc32: level.crc32,
                uncompressedSize: level.uncompressedSize,
            },
        ],
    }
    const damaged = await bytes(original)
    flip(damaged, level.dataOffset + 2)
    await assert.rejects(
        executePlan(plan, new Map([['t', { ...source, file: new Blob([damaged]) }]])),
        { code: 'io' },
    )
})
