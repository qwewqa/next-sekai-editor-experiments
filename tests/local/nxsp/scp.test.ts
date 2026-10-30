import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deflateRawSync, deflateSync, gunzipSync } from 'node:zlib'
import {
    executePlan,
    ExecutionError,
    inspectNxsp,
    planNxsp,
    readNxsp,
} from '../../../src/local/nxsp'
import { gunzipLevel, gzipLevel } from '../../../src/local/nxsp/gzip'
import { PlanError } from '../../../src/local/nxsp/plan'
import { scpLevelName, scpPaths } from '../../../src/local/nxsp/scp'
import {
    SCP_BGM,
    SCP_COVER,
    SCP_MEDIA_PATHS,
    scpSilenceSeconds,
    scpSilentMp3Size,
} from '../../../src/local/nxsp/scpMedia'
import { checkBuilt } from '../../../src/local/save/verify'
import { crc32 } from '../../../src/zip/crc32'
import { nxspFolder, webFolder } from '../../fixtures-v1/folders'
import { fresh } from './chain'
import {
    crafted,
    freshFile,
    jsonOf,
    levelOf,
    reasonsOf,
    setJson,
    unzip,
    zipItems,
    type Item,
} from './craft'
import { COVER_2, memorySource, PREVIEW } from './helpers'

const encoder = new TextEncoder()
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value))
const sha1 = (value: Uint8Array) => createHash('sha1').update(value).digest('hex')
const resource = (items: Item[], name: string) => ({
    hash: sha1(items.find((item) => item.name === name)!.data),
    url: `/${name}`,
})
const payload = (items: Item[]) => {
    const item = items.find((entry) => entry.name === 'level.json.gz')
    assert.ok(item)
    return item
}
const assertNoDummySrl = (value: unknown) => {
    if (typeof value !== 'object' || value === null) return
    if (Object.hasOwn(value, 'hash') && Object.hasOwn(value, 'url'))
        assert.match((value as { hash: string }).hash, /^[0-9a-f]{40}$/)
    for (const child of Object.values(value)) assertNoDummySrl(child)
}

test('silent BGM follows the note clock, offsets and upward rounding without allocating past the cap', () => {
    const bpm = (beat: number, value: number) => ({
        archetype: '#BPM_CHANGE',
        data: [
            { name: '#BEAT', value: beat },
            { name: '#BPM', value },
        ],
    })
    const note = (beat: number, archetype = 'NormalTapNote') => ({
        archetype,
        data: [{ name: '#BEAT', value: beat }],
    })
    const duration = (entities: unknown[], bgmOffset = 0) =>
        scpSilenceSeconds({ entities, bgmOffset })
    assert.equal(duration([]), 1)
    assert.equal(duration([bpm(0, 120), bpm(1000, 1), note(9000, 'StageStyle')], 9000), 1)
    assert.equal(duration([bpm(0, 120), note(4)]), 3)
    assert.equal(duration([bpm(4, 60), note(8), bpm(0, 120)], 0.25), 8)
    assert.equal(
        duration([bpm(0, 120), note(12, 'FakeAnchorNote'), note(8, 'NormalTailReleaseNote')]),
        7,
    )
    assert.equal(
        duration([
            bpm(0, 120),
            note(4),
            {
                archetype: '#TIMESCALE_CHANGE',
                data: [
                    { name: '#BEAT', value: 2 },
                    { name: '#TIMESCALE', value: -5 },
                ],
            },
        ]),
        3,
    )
    assert.equal(duration([bpm(0, 120), note(4)], -9), 1)
    assert.equal(duration([bpm(0, 120), note(16, 'NormalTailReleaseNote')]), 9)
    assert.equal(duration([bpm(0, 120), note(-4)]), 1)
    assert.equal(duration([bpm(4, 120), note(8)]), 3)
    assert.equal(scpSilentMp3Size(1, 4096), 4032)
    assert.throws(
        () => scpSilentMp3Size(1, 4031),
        (error) => error instanceof PlanError && error.limit === 'bgm',
    )
    for (const seconds of [Infinity, Number.MAX_VALUE, 1e20])
        assert.throws(() => scpSilentMp3Size(seconds, 1024 ** 3), PlanError)
    assert.throws(() => duration([note(4)]), PlanError)
})

test('package fallbacks stay out of project media and history and missing derived bytes remain readable', async () => {
    const { input } = fresh()
    input.media = {}
    input.levelInfo = { ...input.levelInfo, cover: undefined, preview: undefined }
    input.headBgm = null
    const built = planNxsp(input)
    const file = await executePlan(built.plan, new Map())
    const { items, modified } = await unzip(file)
    const project = jsonOf(items, 'project.json')
    assert.equal(project.bgm, undefined)
    assert.equal(project.metadata?.cover, undefined)
    assert.deepEqual(levelOf(items), input.level)
    const read = await readNxsp(file)
    assert.ok(read.kind === 'nxsp' && read.open === 'full')
    assert.deepEqual(read.media, {})
    assert.ok(read.history)
    await checkBuilt(file, built.storageChunks)
    for (const path of SCP_MEDIA_PATHS) {
        const changed = items.map((item) => ({ ...item }))
        changed.find((item) => item.name === path)!.data = new Uint8Array([255])
        for (const name of scpPaths(input.id).slice(2)) {
            const value = jsonOf(changed, name)
            const level = value.item ?? value.items?.[0] ?? value.sections[0].items[0]
            level[path === SCP_BGM ? 'bgm' : 'cover'] = resource(changed, path)
            setJson(changed, name, value)
        }
        const corrupt = await zipItems(changed, modified)
        const opened = await readNxsp(corrupt)
        assert.ok(opened.kind === 'nxsp' && opened.open === 'full')
        await assert.rejects(checkBuilt(corrupt, []), /fallback bytes/)
        const dir = mkdtempSync(join(tmpdir(), 'nxsp-fallback-'))
        try {
            const file = join(dir, 'fallback.nxsp')
            writeFileSync(file, new Uint8Array(await corrupt.arrayBuffer()))
            const result = spawnSync('uv', ['run', 'python', '-I', 'tools/nxsp_check.py', file], {
                encoding: 'utf8',
            })
            assert.notEqual(result.status, 0)
            assert.match(result.stdout + result.stderr, /fallback (cover|BGM):/)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    }
    const old = await zipItems(
        items.filter((item) => !SCP_MEDIA_PATHS.includes(item.name)),
        modified,
    )
    const oldRead = await readNxsp(old)
    assert.ok(oldRead.kind === 'nxsp' && oldRead.open === 'full')
    for (const name of ['sonolus/cover.jpg', 'sonolus/bgm.wav', 'sonolus/media/bgm.mp3']) {
        const unknown = await zipItems(
            [...items, { name, data: new Uint8Array(), method: 'store' }],
            modified,
        )
        const opened = await readNxsp(unknown)
        assert.ok(opened.kind === 'nxsp' && opened.open === 'partial')
    }
})

test('canonical project fixtures contain the five level endpoints and real resource links', async () => {
    const paths = [
        ...readdirSync(nxspFolder)
            .filter((name) => name.endsWith('.nxsp'))
            .map((name) => join(nxspFolder, name)),
        join(webFolder, 'saving-marker-file.nxsp'),
    ]
    assert.equal(paths.length, 9)
    for (const path of paths) {
        const file = new Blob([readFileSync(path)])
        const { items } = await unzip(file)
        const endpoints = items.filter(
            (entry) => entry.name.startsWith('sonolus/') && !SCP_MEDIA_PATHS.includes(entry.name),
        )
        assert.equal(endpoints.length, 5, path)
        assert.deepEqual(
            endpoints.map((entry) => entry.name),
            scpPaths(jsonOf(items, 'project.json').id),
            path,
        )
        for (const entry of endpoints) assertNoDummySrl(jsonOf(items, entry.name))
        await checkBuilt(file, [])
    }
})

test('the package shares one deterministic gzip chart and only the included current media', async () => {
    const { input } = fresh()
    const first = planNxsp(input)
    const file = await executePlan(first.plan, new Map())
    const again = await executePlan(planNxsp(fresh().input).plan, new Map())
    assert.deepEqual(await file.arrayBuffer(), await again.arrayBuffer())
    const { items } = await unzip(file)
    assert.equal(jsonOf(items, 'project.json').level, 'level.json.gz')
    assert.equal(items.filter((entry) => /^level\.json/.test(entry.name)).length, 1)
    assert.equal(payload(items).method, 'store')
    assert.deepEqual(JSON.parse(gunzipSync(payload(items).data).toString()), input.level)
    assert.deepEqual(levelOf(items), input.level)
    const paths = items
        .filter((entry) => entry.name.startsWith('sonolus/'))
        .map((entry) => entry.name)
    assert.deepEqual(paths, [
        'sonolus/package',
        'sonolus/info',
        'sonolus/levels/info',
        'sonolus/levels/list',
        `sonolus/levels/${scpLevelName(input.id)}`,
    ])
    assert.deepEqual(paths, scpPaths(input.id))
    const list = jsonOf(items, 'sonolus/levels/list').items[0]
    assert.deepEqual(jsonOf(items, 'sonolus/levels/info').sections[0].items[0], list)
    assert.deepEqual(jsonOf(items, `sonolus/levels/${list.name}`).item, list)
    assert.equal(list.source, undefined)
    assert.equal(list.name, scpLevelName(input.id))
    assert.deepEqual(list.data, resource(items, 'level.json.gz'))
    assert.deepEqual(list.cover, resource(items, 'assets/cover.png'))
    assert.deepEqual(list.bgm, resource(items, 'bgm/Coconut-Master.mp3'))
    assert.equal(list.preview, undefined)
    for (const field of ['useSkin', 'useBackground', 'useEffect', 'useParticle'])
        assert.deepEqual(list[field], { useDefault: true })
    assert.equal(list.engine.version, 13)
    assertNoDummySrl(list)
    for (const [kind, version, resources] of [
        ['skin', 4, ['thumbnail', 'data', 'texture']],
        ['background', 2, ['thumbnail', 'data', 'image', 'configuration']],
        ['effect', 5, ['thumbnail', 'data', 'audio']],
        ['particle', 3, ['thumbnail', 'data', 'texture']],
    ] as const) {
        const item = list.engine[kind]
        assert.equal(item.version, version)
        assert.equal(item.name, 'coconut-next-sekai-1')
        assert.equal(item.source, 'https://coconut.sonolus.com/next-sekai')
        for (const key of ['title', 'subtitle', 'author']) assert.equal(typeof item[key], 'string')
        assert.ok(Array.isArray(item.tags))
        for (const resource of resources) assert.deepEqual(item[resource], {})
    }
    for (const resource of [
        'thumbnail',
        'playData',
        'watchData',
        'previewData',
        'tutorialData',
        'configuration',
    ])
        assert.deepEqual(list.engine[resource], {})
    assert.equal(Object.hasOwn(list.engine, 'rom'), false)
    await checkBuilt(file, first.storageChunks)
})

test('projection identity, title fallbacks and numeric metadata come from the saved project', async () => {
    const { input } = fresh()
    for (const rating of [-1.25, 0, 12.5]) {
        const built = planNxsp({
            ...input,
            id: '../arbitrary/\ud800',
            levelInfo: {
                ...input.levelInfo,
                title: '',
                rating,
                cover: undefined,
                preview: undefined,
            },
            history: undefined,
            headBgm: null,
            media: {},
        })
        const { items } = await unzip(await executePlan(built.plan, new Map()))
        const item = jsonOf(items, 'sonolus/levels/list').items[0]
        assert.match(item.name, /^nse-[0-9a-f]{32}$/)
        assert.equal(item.name, scpLevelName('../arbitrary/\ufffd'))
        assert.equal(item.title, 'coconut')
        assert.equal(item.rating, rating)
        assert.deepEqual(item.bgm, resource(items, SCP_BGM))
        assert.deepEqual(item.cover, resource(items, SCP_COVER))
        assertNoDummySrl(item)
    }
    const buildTitle = async (name: string | undefined) => {
        const changed = {
            ...input,
            name,
            revision: { ...input.revision, fileName: undefined },
            levelInfo: { ...input.levelInfo, title: '' },
        }
        const { items } = await unzip(await executePlan(planNxsp(changed).plan, new Map()))
        return jsonOf(items, 'sonolus/levels/list').items[0].title
    }
    assert.equal(await buildTitle('Project name'), 'Project name')
    assert.equal(await buildTitle(undefined), scpLevelName(input.id))
    assert.notEqual(scpLevelName('copy'), scpLevelName(input.id))
})

test('only saved media bytes produce complete resource links', async () => {
    const { input } = fresh()
    for (const held of [false, true]) {
        const built = planNxsp({
            ...input,
            media: held
                ? {
                      ...input.media,
                      preview: {
                          bytes: PREVIEW.bytes,
                          sha256: PREVIEW.sha256,
                          type: 'audio/mpeg',
                          filename: 'preview.mp3',
                      },
                  }
                : {
                      cover: COVER_2.ref,
                      preview: input.media.preview,
                  },
        })
        const file = await executePlan(built.plan, new Map())
        const { items } = await unzip(file)
        const level = jsonOf(items, 'sonolus/levels/list').items[0]
        assertNoDummySrl(level)
        for (const key of ['cover', 'bgm', 'preview']) {
            assert.equal(Object.hasOwn(level, key), held || key !== 'preview')
            if (held) {
                assert.deepEqual(level[key], resource(items, level[key].url.slice(1)))
            } else if (key !== 'preview')
                assert.deepEqual(level[key], resource(items, key === 'bgm' ? SCP_BGM : SCP_COVER))
        }
        await checkBuilt(file, built.storageChunks)
    }
})

test('copied STORE and DEFLATE media use their bytes despite stale source resource hashes', async () => {
    for (const method of ['store', 'deflate'] as const) {
        const { input } = fresh()
        input.media.preview = {
            bytes: PREVIEW.bytes,
            sha256: PREVIEW.sha256,
            type: 'audio/mpeg',
            filename: 'preview.mp3',
        }
        const { items, modified } = await unzip(await executePlan(planNxsp(input).plan, new Map()))
        for (const item of items) {
            if (item.name.startsWith('assets/') || item.name.startsWith('bgm/'))
                item.method = method
            if (scpPaths(input.id).slice(2).includes(item.name)) {
                const value = jsonOf(items, item.name)
                const level = value.item ?? value.items?.[0] ?? value.sections[0].items[0]
                for (const key of ['data', 'bgm', 'cover', 'preview'])
                    level[key].hash = '0'.repeat(40)
                item.data = bytes(value)
            }
        }
        const file = await zipItems(items, modified)
        const source = await inspectNxsp(file, {
            token: 'source',
            role: 'target',
            fingerprint: 'zip:test',
        })
        for (const kind of ['bgm', 'cover', 'preview'] as const) {
            const media = input.media[kind]!
            assert.ok('bytes' in media)
            const entry = source.entries.find((entry) =>
                entry.name.startsWith(kind === 'bgm' ? 'bgm/' : `assets/${kind}.`),
            )!
            input.media[kind] = {
                copy: { source: 'source', entryIndex: entry.index },
                sha256: media.sha256,
                type: media.type,
                filename: media.filename,
            }
        }
        const built = planNxsp(input, [source])
        const result = await executePlan(built.plan, new Map([['source', memorySource(file)]]))
        const written = (await unzip(result)).items
        const level = jsonOf(written, 'sonolus/levels/list').items[0]
        for (const key of ['data', 'bgm', 'cover', 'preview'])
            assert.deepEqual(level[key], resource(written, level[key].url.slice(1)))
        await checkBuilt(result, built.storageChunks)
    }
})

test('resource hashing failures do not blame a source and changes during hashing remain conflicts', async (t) => {
    const { input } = fresh()
    const file = await executePlan(planNxsp(input).plan, new Map())
    const pinned = await inspectNxsp(file, {
        token: 'source',
        role: 'target',
        fingerprint: 'zip:test',
    })
    const bgm = input.media.bgm!
    assert.ok('bytes' in bgm)
    input.media.bgm = {
        copy: {
            source: 'source',
            entryIndex: pinned.entries.find((entry) => entry.name.startsWith('bgm/'))!.index,
        },
        sha256: bgm.sha256,
        type: bgm.type,
        filename: bgm.filename,
    }
    const plan = planNxsp(input, [pinned]).plan
    const source = memorySource(file)
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    const failed = new Error('digest unavailable')
    const mock = t.mock.method(
        crypto.subtle,
        'digest',
        async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
            if (
                algorithm === 'SHA-1' &&
                data instanceof Uint8Array &&
                data.length === bgm.bytes.length &&
                data.every((byte, i) => byte === bgm.bytes[i])
            )
                throw failed
            return digest(algorithm, data)
        },
    )
    await assert.rejects(
        executePlan(plan, new Map([['source', source]])),
        (error) => error === failed,
    )
    mock.mock.restore()
    t.mock.method(
        crypto.subtle,
        'digest',
        async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
            if (algorithm === 'SHA-1') source.changed = true
            return digest(algorithm, data)
        },
    )
    await assert.rejects(
        executePlan(plan, new Map([['source', source]])),
        (error) =>
            error instanceof ExecutionError &&
            error.code === 'conflict' &&
            error.source?.token === 'source',
    )
})

test('strict checks reject resource SHA-1 changes even when all package views agree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nxsp-srl-hash-'))
    try {
        for (const key of ['data', 'cover', 'bgm']) {
            const file = await crafted((items) => {
                const project = jsonOf(items, 'project.json')
                for (const name of scpPaths(project.id).slice(2)) {
                    const value = jsonOf(items, name)
                    const level = value.item ?? value.items?.[0] ?? value.sections[0].items[0]
                    level[key].hash = '0'.repeat(40)
                    setJson(items, name, value)
                }
            })
            await assert.rejects(checkBuilt(file, []), /project projection/)
            const path = join(dir, `${key}.nxsp`)
            writeFileSync(path, new Uint8Array(await file.arrayBuffer()))
            const result = spawnSync('uv', ['run', 'python', '-I', 'tools/nxsp_check.py', path], {
                encoding: 'utf8',
            })
            assert.notEqual(result.status, 0)
            assert.match(result.stdout + result.stderr, /project projection/)
        }
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('gzip rejects damaged wrappers, extra members, trailing bytes and oversized JSON', () => {
    const plain = bytes({ entities: [], bgmOffset: 0 })
    const good = gzipLevel(plain)
    assert.deepEqual(gunzipLevel(good, plain.length), plain)
    const corrupt = (offset: number) => {
        const data = good.slice()
        data[offset] = (data[offset] ?? 0) ^ 1
        return data
    }
    for (const data of [
        plain,
        deflateSync(plain),
        deflateRawSync(plain),
        good.slice(0, -1),
        corrupt(good.length - 8),
        corrupt(good.length - 4),
        corrupt(2),
        new Uint8Array([...good, 0]),
        new Uint8Array([...good, ...good]),
    ])
        assert.throws(() => gunzipLevel(data, plain.length))
    assert.throws(() => gunzipLevel(good, plain.length - 1))
    const optional = new Uint8Array([
        ...good.slice(0, 10),
        1,
        0,
        42,
        110,
        0,
        99,
        0,
        0,
        0,
        ...good.slice(10),
    ])
    optional[3] = 4 | 8 | 16 | 2
    new DataView(optional.buffer).setUint16(17, crc32(optional.subarray(0, 17)) & 0xffff, true)
    assert.deepEqual(gunzipLevel(optional, plain.length), plain)
    optional[17] = (optional[17] ?? 0) ^ 1
    assert.throws(() => gunzipLevel(optional, plain.length))
})

test('supported pointers never recover a stale alternate, and ambiguous recovery refuses to guess', async () => {
    const withPlain = (items: Item[]) =>
        items.push({
            name: 'level.json',
            data: bytes({ entities: [], bgmOffset: 99 }),
            method: 'deflate',
        })
    const valid = await readNxsp(
        await crafted((items) => {
            withPlain(items)
        }),
    )
    assert.equal(valid.kind, 'nxsp')
    if (valid.kind !== 'nxsp') return
    assert.equal(valid.open, 'partial')
    assert.deepEqual(reasonsOf(valid), ['unknown-entry level.json'])
    const broken = await readNxsp(
        await crafted((items) => {
            withPlain(items)
            payload(items).data = bytes({})
        }),
    )
    assert.equal(broken.kind, 'unreadable')
    const missing = await readNxsp(
        await crafted((items) => {
            withPlain(items)
            return items.filter((entry) => entry.name !== 'level.json.gz')
        }),
    )
    assert.equal(missing.kind, 'unreadable')
    for (const version of [1, 2]) {
        const read = await readNxsp(
            await crafted((items) => {
                withPlain(items)
                setJson(items, 'project.json', {
                    ...jsonOf(items, 'project.json'),
                    version,
                    level: 'unknown',
                })
            }),
        )
        assert.equal(read.kind, 'unreadable')
    }
    const recovered = await readNxsp(
        await crafted((items) =>
            setJson(items, 'project.json', { ...jsonOf(items, 'project.json'), level: null }),
        ),
    )
    assert.equal(recovered.kind, 'nxsp')
    if (recovered.kind === 'nxsp') assert.equal(recovered.open, 'partial')
})

test('only the owned projection is disposable; strict built-file checks reject a stale projection', async () => {
    for (const change of [
        (items: Item[]) => items.filter((entry) => !entry.name.startsWith('sonolus/')),
        (items: Item[]) => {
            setJson(items, 'sonolus/levels/list', { items: [] })
            return items
        },
        (items: Item[]) => {
            const entry = items.find((entry) => entry.name === 'sonolus/info')!
            entry.data = new Uint8Array([255])
            return items
        },
    ]) {
        const file = await crafted(change)
        const read = await readNxsp(file)
        assert.ok(read.kind === 'nxsp')
        assert.equal(read.open, 'full')
        assert.ok(read.history)
        await assert.rejects(checkBuilt(file, []))
    }
    for (const name of [
        'sonolus/levels/nse-other',
        'sonolus/repository/data',
        'sonolus/unknown',
        'sonolus/engines/info',
        'sonolus/skins/list',
    ]) {
        const read = await readNxsp(
            await crafted((items) => {
                items.push({ name, data: bytes({}), method: 'store' })
            }),
        )
        assert.ok(reasonsOf(read).includes(`unknown-entry ${name}`))
    }
})

test('the Python reader agrees on new gzip failures and exact projection ownership', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nxsp-scp-'))
    try {
        const cases = [
            await freshFile(),
            await crafted((items) => {
                payload(items).data = new Uint8Array([...payload(items).data, 0])
            }),
            await crafted((items) => {
                setJson(items, 'sonolus/levels/list', {})
            }),
            await crafted((items) => {
                items.push({ name: 'sonolus/unknown', data: bytes({}), method: 'store' })
            }),
            await crafted((items) => {
                items.push({
                    name: 'sonolus/engines/info',
                    data: bytes({ sections: [] }),
                    method: 'deflate',
                })
            }),
        ]
        const plain = bytes({ entities: [], bgmOffset: 0 })
        const good = gzipLevel(plain)
        const badCrc = good.slice()
        badCrc[badCrc.length - 8] = (badCrc[badCrc.length - 8] ?? 0) ^ 1
        const badSize = good.slice()
        badSize[badSize.length - 4] = (badSize[badSize.length - 4] ?? 0) ^ 1
        for (const data of [
            plain,
            deflateSync(plain),
            deflateRawSync(plain),
            good.slice(0, -1),
            badCrc,
            badSize,
            new Uint8Array([...good, ...good]),
            gzipLevel(new Uint8Array([255])),
            gzipLevel(encoder.encode('['.repeat(66) + '0' + ']'.repeat(66))),
        ]) {
            cases.push(
                await crafted((items) => {
                    payload(items).data = data
                }),
            )
        }
        cases.push(
            await crafted((items) => {
                items.push({ name: 'level.json', data: plain, method: 'deflate' })
                payload(items).data = badCrc
            }),
        )
        cases.push(
            await crafted((items) => {
                items.push({ name: 'level.json', data: plain, method: 'deflate' })
                setJson(items, 'project.json', { ...jsonOf(items, 'project.json'), version: 2 })
            }),
        )
        const paths: string[] = []
        for (const [i, file] of cases.entries()) {
            const path = join(dir, `${i}.nxsp`)
            paths.push(path)
            writeFileSync(path, new Uint8Array(await file.arrayBuffer()))
        }
        const result = spawnSync(
            'uv',
            ['run', 'python', '-I', 'tools/nxsp_check.py', '--read', ...paths],
            { encoding: 'utf8' },
        )
        assert.equal(result.status, 0, result.stderr)
        const reports = result.stdout
            .trim()
            .split(/\r?\n/)
            .map((line) => JSON.parse(line))
        for (const [i, file] of cases.entries()) {
            const read = await readNxsp(file)
            assert.equal(reports[i].kind, read.kind)
            if (read.kind === 'nxsp') assert.equal(reports[i].open, read.open)
            if (read.kind !== 'not-project')
                assert.deepEqual(
                    reports[i].report,
                    read.report.map(({ reason, path }) => [reason, path]),
                )
            const strict = spawnSync(
                'uv',
                ['run', 'python', '-I', 'tools/nxsp_check.py', paths[i]!],
                { encoding: 'utf8' },
            )
            assert.equal(strict.status === 0, i === 0, strict.stdout + strict.stderr)
        }
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
