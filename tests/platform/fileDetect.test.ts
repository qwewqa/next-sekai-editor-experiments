import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { classifyZipNames, detectContent, detectHead, isMpegHeader } from '../../src/files/detect'
import { buildZip, type ZipInput } from '../../src/zip'

const utf8 = (text: string) => new TextEncoder().encode(text)
const file = (parts: BlobPart[], name: string, type = '') => new File(parts, name, { type })
const bytes = (...values: number[]) => new Uint8Array(values)
const pad = (head: Uint8Array, length = 200) => {
    const out = new Uint8Array(length)
    out.set(head)
    return out
}

const levelData = JSON.stringify({
    version: 1,
    entities: [{ archetype: 'Initialization', data: [] }],
})
const entry = (name: string, content = ''): ZipInput => ({
    name,
    method: 'deflate',
    data: utf8(content),
})
const zipFile = async (name: string, entries: ZipInput[]) => file([await buildZip(entries)], name)

test('audio is found by content, so renamed and extensionless files work', async () => {
    const samples: [string, Uint8Array<ArrayBuffer>][] = [
        ['ID3', pad(bytes(0x49, 0x44, 0x33, 0x04))],
        ['MPEG frame', pad(bytes(0xff, 0xfb, 0x90, 0x00))],
        ['MPEG-2 layer III', pad(bytes(0xff, 0xf3, 0x48, 0xc4))],
        ['Ogg', pad(bytes(0x4f, 0x67, 0x67, 0x53, 0x00, 0x02))],
        ['WAV', pad(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45))],
        ['FLAC', pad(bytes(0x66, 0x4c, 0x61, 0x43))],
        ['M4A', pad(bytes(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20))],
        ['WebM', pad(bytes(0x1a, 0x45, 0xdf, 0xa3))],
    ]
    for (const [label, content] of samples) {
        for (const name of ['song.mp3', 'song.txt', 'LevelData', 'song.json']) {
            assert.deepEqual(
                await detectContent(file([content], name)),
                { kind: 'audio' },
                `${label} ${name}`,
            )
        }
    }
})

test('a file with an audio MIME type is audio, as it always was', async () => {
    assert.deepEqual(await detectContent(file([utf8('not really')], 'a.bin', 'audio/mpeg')), {
        kind: 'audio',
    })
})

test('content comes before the MIME type: a ZIP with an audio type is a ZIP', async () => {
    const zip = await buildZip([entry('a.txt')])
    assert.deepEqual(await detectContent(file([zip], 'a.mp3', 'audio/mpeg')), {
        kind: 'zip',
        zip: 'other',
    })
    assert.equal(await detectHead(file([zip], 'a.mp3', 'audio/mpeg')), 'zip')
})

test('a UTF-16 text file is not mistaken for MP3', async () => {
    // Its byte-order mark FF FE reads as a sync word, and the next bytes can pass the field checks.
    const sources = [levelData, '{ "entities": [] }', 'a plain note\n', '[1, 2, 3]']
    for (const source of sources) {
        const utf16le = new Uint8Array(2 + source.length * 2)
        utf16le.set([0xff, 0xfe])
        for (let i = 0; i < source.length; i++) {
            utf16le[2 + i * 2] = source.charCodeAt(i) & 0xff
            utf16le[3 + i * 2] = source.charCodeAt(i) >> 8
        }
        assert.ok(!isMpegHeader(utf16le), source)
        assert.deepEqual(await detectContent(file([utf16le], 'chart.txt')), { kind: 'data' })
    }

    // The same with a UTF-16 BE mark, which never was a sync word.
    assert.deepEqual(await detectContent(file([bytes(0xfe, 0xff, 0, 0x7b, 0, 0x7d)], 'a.txt')), {
        kind: 'data',
    })
})

test('MPEG header validation rejects each reserved field', () => {
    assert.ok(isMpegHeader(bytes(0xff, 0xfb, 0x90, 0x00)))
    assert.ok(!isMpegHeader(bytes(0xff, 0xfb, 0xf0, 0x00)), 'bitrate index 1111')
    assert.ok(!isMpegHeader(bytes(0xff, 0xfb, 0x9c, 0x00)), 'sample-rate index 11')
    assert.ok(!isMpegHeader(bytes(0xff, 0xeb, 0x90, 0x00)), 'version 01')
    assert.ok(!isMpegHeader(bytes(0xff, 0xf9, 0x90, 0x00)), 'layer 00')
    assert.ok(!isMpegHeader(bytes(0xff, 0xfb, 0x90, 0x02)), 'emphasis 10')
    assert.ok(!isMpegHeader(bytes(0xff, 0xdb, 0x90, 0x00)), 'no sync')
    assert.ok(!isMpegHeader(bytes(0xfe, 0xfb, 0x90, 0x00)))
    assert.ok(!isMpegHeader(bytes(0xff, 0xfb)))
})

test('level data, in each form Open reads, goes to the whole-file path', async () => {
    const forms: [string, BlobPart][] = [
        ['LevelData', gzipSync(levelData)],
        ['LevelData.json', levelData],
        ['chart.nsld', gzipSync(levelData)],
        ['chart.json.gz', gzipSync(levelData)],
        ['chart.gz', gzipSync(levelData)],
        ['chart.usc', JSON.stringify({ usc: { objects: [], offset: 0 }, version: 2 })],
        ['chart.sus', Array.from({ length: 12 }, (_, i) => `#META${i} "x"`).join('\n')],
        ['', levelData],
    ]
    for (const [name, content] of forms) {
        assert.deepEqual(await detectContent(file([content], name)), { kind: 'data' }, name)
    }
})

test('an archive is recognised by its entry names', async () => {
    // An apps’ backup: a manifest and project files.
    assert.deepEqual(
        await detectContent(
            await zipFile('Next SEKAI Editor backup 2026-10-17.zip', [
                entry('manifest.json', '{}'),
                entry('coconut.nxsp'),
                entry('other.nxsp'),
            ]),
        ),
        { kind: 'zip', zip: 'archive' },
    )
    // A ZIP of project files made by hand, with no manifest, in a folder, with OS clutter.
    assert.deepEqual(
        await detectContent(
            await zipFile('charts.zip', [
                entry('charts/a.nxsp'),
                entry('charts/b.nxsp'),
                entry('__MACOSX/charts/._a.nxsp'),
                entry('.DS_Store'),
            ]),
        ),
        { kind: 'zip', zip: 'archive' },
    )
    // Clutter alone is not an archive.
    assert.deepEqual(
        await detectContent(
            await zipFile('x.zip', [entry('__MACOSX/._manifest.json'), entry('a.txt')]),
        ),
        { kind: 'zip', zip: 'other' },
    )
})

test('a project file is a ZIP whose project.json says nxsp', async () => {
    const project = await zipFile('v1.2 final', [
        entry('project.json', JSON.stringify({ format: 'nxsp', version: 1 })),
        entry('level.json', levelData),
    ])
    assert.deepEqual(await detectContent(project), { kind: 'zip', zip: 'project' })

    // Not a project file: another format, a project.json that is not JSON, or none.
    for (const content of [JSON.stringify({ format: 'other' }), 'not json', '[]', 'null']) {
        assert.deepEqual(
            await detectContent(await zipFile('p.nxsp', [entry('project.json', content)])),
            { kind: 'zip', zip: 'other' },
            content,
        )
    }

    // A project file beside the manifest of an archive is still a project file.
    assert.deepEqual(
        await detectContent(
            await zipFile('both.zip', [
                entry('project.json', JSON.stringify({ format: 'nxsp' })),
                entry('manifest.json', '{}'),
            ]),
        ),
        { kind: 'zip', zip: 'project' },
    )
})

test('a Sonolus package is recognised, and so is a plain ZIP, an empty one and a damaged one', async () => {
    assert.deepEqual(
        await detectContent(
            await zipFile('skin.scp', [entry('sonolus/info', '{}'), entry('data')]),
        ),
        { kind: 'zip', zip: 'package' },
    )
    // The shipped packages have lists and no `sonolus/info`.
    assert.deepEqual(
        await detectContent(
            await zipFile('skin.scp', [
                entry('sonolus/skins/list', '{}'),
                entry('data'),
                entry('texture'),
            ]),
        ),
        { kind: 'zip', zip: 'package' },
    )
    assert.deepEqual(
        await detectContent(await zipFile('photos.zip', [entry('a.png'), entry('b.png')])),
        {
            kind: 'zip',
            zip: 'other',
        },
    )
    assert.deepEqual(await detectContent(await zipFile('empty.zip', [])), {
        kind: 'zip',
        zip: 'other',
    })

    const damaged = await zipFile('cut.nxsp', [
        entry('project.json', JSON.stringify({ format: 'nxsp' })),
        entry('level.json', levelData),
    ])
    const cut = new Uint8Array(await damaged.arrayBuffer()).subarray(0, 60)
    assert.deepEqual(await detectContent(file([cut], 'cut.nxsp')), { kind: 'zip', zip: 'other' })
})

test('the shipped .scp files are packages', { skip: !hasShipped() }, async () => {
    for (const name of ['skin', 'particle']) {
        const content = readFileSync(`public/resource/${name}.scp`)
        assert.deepEqual(await detectContent(file([content], `${name}.scp`)), {
            kind: 'zip',
            zip: 'package',
        })
    }
})

test('entry names classify without opening anything', () => {
    assert.equal(classifyZipNames(['manifest.json']), 'archive')
    assert.equal(classifyZipNames(['a/b.nxsp']), 'archive')
    assert.equal(classifyZipNames(['sonolus/info']), 'package')
    assert.equal(classifyZipNames(['level.json']), 'other')
    assert.equal(classifyZipNames([]), 'other')
})

test('only the first 64 bytes are read to identify a file', async () => {
    const content = new Blob([utf8(levelData)])
    const slices: [number, number][] = []
    const spy = {
        type: '',
        slice(start: number, end: number) {
            slices.push([start, end])
            return content.slice(start, end)
        },
    } as unknown as Blob
    assert.deepEqual(await detectContent(spy), { kind: 'data' })
    assert.deepEqual(slices, [[0, 64]])
})

// The locked packages only: nativeBundle.test.mjs plants a stand-in while it builds.
function hasShipped() {
    const lock = JSON.parse(readFileSync('deployment/preview-assets.lock.json', 'utf8'))
    return ['skin', 'particle'].every((name) => {
        try {
            const bytes = readFileSync(`public/resource/${name}.scp`)
            return createHash('sha256').update(bytes).digest('hex') === lock[name].sha256
        } catch {
            return false
        }
    })
}

test('Open tells a ZIP from its first 64 bytes without opening it', async () => {
    const content = await buildZip([entry('project.json', '{"format":"nxsp"}')])
    const slices: [number, number][] = []
    const spy = {
        size: content.size,
        type: '',
        slice(start: number, end: number) {
            slices.push([start, end])
            return content.slice(start, end)
        },
    } as unknown as Blob
    assert.equal(await detectHead(spy), 'zip')
    assert.deepEqual(slices, [[0, 64]])
})

test('Open leaves a peek before its audio branch changes the BGM', () => {
    // The command module loads Vue components, so its source is checked instead.
    const source = readFileSync('src/editor/commands/open/index.ts', 'utf8')
    assert.ok(/leavePeek\(\)\s*void changeBgm\(file\)/.test(source))
    assert.ok(!/readOnly:\s*true/.test(source))
})

test('Open sniffs the head only, never the whole content', () => {
    const source = readFileSync('src/editor/commands/open/index.ts', 'utf8')
    assert.ok(/\bdetectHead\b/.test(source))
    assert.ok(!/\bdetectContent\b/.test(source))
})

test('Open, Undo and Redo leave the peek before they run (peekGate.test.ts)', () => {
    for (const name of ['open', 'undo', 'redo']) {
        const source = readFileSync(`src/editor/commands/${name}/index.ts`, 'utf8')
        assert.ok(/leavesPeek:\s*true/.test(source), name)
    }
})
