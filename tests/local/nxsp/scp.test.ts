import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deflateRawSync, deflateSync, gunzipSync } from 'node:zlib'
import { executePlan, planNxsp, readNxsp } from '../../../src/local/nxsp'
import { gunzipLevel, gzipLevel } from '../../../src/local/nxsp/gzip'
import { scpLevelName, scpPaths } from '../../../src/local/nxsp/scp'
import { checkBuilt } from '../../../src/local/save/verify'
import { crc32 } from '../../../src/zip/crc32'
import { nxspFolder, webFolder } from '../../fixtures-v1/folders'
import { fresh } from './chain'
import { crafted, freshFile, jsonOf, levelOf, reasonsOf, setJson, unzip, type Item } from './craft'
import { COVER_2, PREVIEW } from './helpers'

const encoder = new TextEncoder()
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value))
const payload = (items: Item[]) => {
    const item = items.find((entry) => entry.name === 'level.json.gz')
    assert.ok(item)
    return item
}
const assertNoDummySrl = (value: unknown) => {
    if (typeof value !== 'object' || value === null) return
    assert.notDeepEqual(value, { hash: '', url: '' })
    for (const child of Object.values(value)) assertNoDummySrl(child)
}

test('canonical project fixtures contain only the five level endpoints and real resource links', async () => {
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
        const endpoints = items.filter((entry) => entry.name.startsWith('sonolus/'))
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
    assert.deepEqual(list.data, { hash: '', url: '/level.json.gz' })
    assert.deepEqual(list.cover, { hash: '', url: '/assets/cover.png' })
    assert.deepEqual(list.bgm, { hash: '', url: '/bgm/Coconut-Master.mp3' })
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
        for (const resource of resources) assert.equal(Object.hasOwn(item, resource), false)
    }
    for (const resource of [
        'thumbnail',
        'playData',
        'watchData',
        'previewData',
        'tutorialData',
        'rom',
        'configuration',
    ])
        assert.equal(Object.hasOwn(list.engine, resource), false)
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
        assert.equal(Object.hasOwn(item, 'bgm'), false)
        assert.equal(Object.hasOwn(item, 'cover'), false)
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

test('only saved media bytes produce resource fields', async () => {
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
            assert.equal(Object.hasOwn(level, key), held)
            if (held) {
                assert.equal(level[key].hash, '')
                assert.ok(items.some((entry) => `/${entry.name}` === level[key].url))
            }
        }
        await checkBuilt(file, built.storageChunks)
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
