import assert from 'node:assert/strict'
import test from 'node:test'
import { Value } from 'typebox/value'
import {
    assetChoiceSchema,
    choiceKey,
    DISMISSED_NOTICE_LIMIT,
    previewAssetsSchema,
} from '../../src/preview/assets/choice'
import { createAssetLoader } from '../../src/preview/assets/loader'
import { fallbackOf, undismissed, withDismissed } from '../../src/preview/assets/notices'
import { noticeKey, reasonKey } from '../../src/preview/assets/reasons'
import { storedLine } from '../../src/preview/assets/stored'
import {
    AssetError,
    type AssetChoice,
    type AssetDefaults,
    type DefaultProvider,
    type LoadContext,
    type Loaded,
} from '../../src/preview/assets/types'
import { insertPreviewAssets } from '../../src/settings/toolbarPreviewAssets'

const context = (): LoadContext => ({
    signal: new AbortController().signal,
    decodeAudio: async () => ({}) as AudioBuffer,
})
const provider =
    (title: string): DefaultProvider<'skin'> =>
    async () =>
        ({ title }) as Loaded['skin']
const set = (skin: DefaultProvider<'skin'>): AssetDefaults => ({
    skin,
    particle: async () => undefined,
    background: async () => undefined,
    effect: async () => undefined,
})
const fileChoice: AssetChoice = {
    source: 'file',
    key: 'abc',
    name: 'item',
    title: 'Item',
    author: 'Author',
    origin: 'item.scp',
}
const bundled: AssetChoice = { source: 'bundled', id: 'skin2' }
const serverChoice: AssetChoice = { ...fileChoice, source: 'server', origin: 'https://example.com' }

test('Default failing with a 404 falls back to Built-in, and says so', async (t) => {
    t.mock.method(console, 'error', () => {})
    const loader = createAssetLoader({
        defaults: set(async () => undefined),
        builtin: set(provider('built-in')),
    })
    const result = await loader.load('skin', { source: 'default' }, context())
    assert.equal(result?.value.title, 'built-in')
    assert.deepEqual(result?.status, { active: 'builtin', reason: 'missing' })
})

test('Default failing for any other reason falls back to Built-in with that reason', async (t) => {
    t.mock.method(console, 'error', () => {})
    for (const [error, reason] of [
        [new AssetError('unavailable', 'HTTP 503'), 'unavailable'],
        [new TypeError('Failed to fetch'), 'corrupt'],
    ] as const) {
        const loader = createAssetLoader({
            defaults: set(async () => {
                throw error
            }),
            builtin: set(provider('built-in')),
        })
        const result = await loader.load('skin', { source: 'default' }, context())
        assert.deepEqual(result?.status, { active: 'builtin', reason })
    }
})

test('the Built-in choice loads Built-in and never asks Default', async () => {
    let asked = false
    const loader = createAssetLoader({
        defaults: set(async () => {
            asked = true
            return undefined
        }),
        builtin: set(provider('built-in')),
    })
    const result = await loader.load('skin', { source: 'builtin' }, context())
    assert.equal(result?.value.title, 'built-in')
    assert.deepEqual(result?.status, { active: 'builtin' })
    assert.equal(asked, false)
})

test('a Built-in choice that fails uses Default and says why', async (t) => {
    t.mock.method(console, 'error', () => {})
    const loader = createAssetLoader({
        defaults: set(provider('default')),
        builtin: set(async () => {
            throw new AssetError('unavailable', 'HTTP 500')
        }),
    })
    const result = await loader.load('skin', { source: 'builtin' }, context())
    assert.equal(result?.value.title, 'default')
    assert.deepEqual(result?.status, { active: 'default', reason: 'unavailable' })
})

test('with Default and Built-in both failing, the chain rejects with Default’s error', async (t) => {
    t.mock.method(console, 'error', () => {})
    const failure = new AssetError('unavailable', 'offline')
    const loader = createAssetLoader({
        defaults: set(async () => {
            throw failure
        }),
        builtin: set(async () => {
            throw new Error('also offline')
        }),
    })
    await assert.rejects(loader.load('skin', { source: 'default' }, context()), failure)
    await assert.rejects(loader.load('skin', { source: 'builtin' }, context()), failure)
    await assert.rejects(loader.load('skin', fileChoice, context()), failure)
})

test('a chosen file that is gone uses Default, then Built-in, keeping the chosen reason', async (t) => {
    t.mock.method(console, 'error', () => {})
    const gone = {
        skin: async () => {
            throw new AssetError('missing', 'not stored')
        },
    }
    const toDefault = createAssetLoader({
        defaults: set(provider('default')),
        builtin: set(provider('built-in')),
        providers: gone,
    })
    assert.deepEqual((await toDefault.load('skin', fileChoice, context()))?.status, {
        active: 'default',
        reason: 'missing',
    })
    const toBuiltin = createAssetLoader({
        defaults: set(async () => undefined),
        builtin: set(provider('built-in')),
        providers: gone,
    })
    const result = await toBuiltin.load('skin', fileChoice, context())
    assert.equal(result?.value.title, 'built-in')
    assert.deepEqual(result?.status, { active: 'builtin', reason: 'missing' })
})

test('where Default is Built-in, the chain does not try it twice', async (t) => {
    t.mock.method(console, 'error', () => {})
    let calls = 0
    const shared = set(async () => {
        calls++
        return undefined
    })
    const loader = createAssetLoader({ defaults: shared, builtin: shared })
    await assert.rejects(loader.load('skin', { source: 'default' }, context()))
    assert.equal(calls, 1)
})

test('a bundled choice loads through its provider and stays the chosen source', async () => {
    const loader = createAssetLoader({
        defaults: set(provider('default')),
        builtin: set(provider('built-in')),
        bundled: { skin: { skin2: provider('Next SEKAI 02') } },
    })
    const result = await loader.load('skin', bundled, context())
    assert.equal(result?.value.title, 'Next SEKAI 02')
    assert.deepEqual(result?.status, { active: 'chosen' })
})

test('a bundled choice that is absent or fails uses Default, then Built-in, with the reason', async (t) => {
    t.mock.method(console, 'error', () => {})
    const absent = async () => undefined
    const failing = async () => {
        throw new AssetError('unavailable', 'HTTP 503')
    }
    for (const [skin2, reason] of [
        [absent, 'missing'],
        [failing, 'unavailable'],
        [undefined, 'missing'],
    ] as const) {
        const toDefault = createAssetLoader({
            defaults: set(provider('default')),
            builtin: set(provider('built-in')),
            bundled: skin2 ? { skin: { skin2 } } : {},
        })
        assert.deepEqual((await toDefault.load('skin', bundled, context()))?.status, {
            active: 'default',
            reason,
        })
        const toBuiltin = createAssetLoader({
            defaults: set(absent),
            builtin: set(provider('built-in')),
            bundled: skin2 ? { skin: { skin2 } } : {},
        })
        const result = await toBuiltin.load('skin', bundled, context())
        assert.equal(result?.value.title, 'built-in')
        assert.deepEqual(result?.status, { active: 'builtin', reason })
    }
})

test('each reason has one sentence for the choice that failed', () => {
    const status = (reason: 'missing' | 'corrupt' | 'unavailable') =>
        ({ active: 'default', reason }) as const
    assert.equal(
        reasonKey({ source: 'default' }, { active: 'builtin', reason: 'missing' }),
        'defaultFailed',
    )
    assert.equal(reasonKey({ source: 'builtin' }, status('unavailable')), 'builtinFailed')
    assert.equal(reasonKey(fileChoice, status('missing')), 'fileGone')
    assert.equal(reasonKey(fileChoice, status('corrupt')), 'invalid')
    assert.equal(reasonKey(serverChoice, status('unavailable')), 'serverFailed')
    assert.equal(reasonKey(serverChoice, status('corrupt')), 'invalid')
    assert.equal(reasonKey(fileChoice, { active: 'chosen' }), undefined)
    assert.equal(reasonKey(bundled, status('missing')), 'bundledFailed')
    assert.equal(reasonKey(bundled, { active: 'chosen' }), undefined)
})

test('a fallback is named by its type, choice and reason, and dismissal is per such key', () => {
    const slot = (choice: AssetChoice, status: object) =>
        ({ state: 'ready', choice, status }) as never
    const gone = fallbackOf('skin', slot(fileChoice, { active: 'default', reason: 'missing' }))
    assert.equal(gone?.key, noticeKey('skin', fileChoice, 'fileGone'))
    assert.equal(gone?.key, 'skin|file:abc|fileGone')
    assert.equal(gone?.using, 'default')
    assert.equal(fallbackOf('skin', slot(fileChoice, { active: 'chosen' })), undefined)
    assert.equal(fallbackOf('skin', { state: 'loading' }), undefined)

    const dismissed = withDismissed([], gone!.key)
    // Hidden for that choice and reason, shown again for a different failed choice or a new reason.
    assert.deepEqual(undismissed([gone!], dismissed), [])
    const other = fallbackOf(
        'skin',
        slot({ ...fileChoice, key: 'def' }, { active: 'default', reason: 'missing' }),
    )
    assert.deepEqual(undismissed([other!], dismissed), [other])
    const changed = fallbackOf('skin', slot(fileChoice, { active: 'default', reason: 'corrupt' }))
    assert.equal(changed?.reason, 'invalid')
    assert.deepEqual(undismissed([changed!], dismissed), [changed])
    // The same choice failing for another type is its own notice.
    const particle = fallbackOf(
        'particle',
        slot(fileChoice, { active: 'default', reason: 'missing' }),
    )
    assert.deepEqual(undismissed([particle!], dismissed), [particle])
})

test('the dismissed list keeps the newest few, once each', () => {
    let list: readonly string[] = []
    for (let i = 0; i < DISMISSED_NOTICE_LIMIT + 5; i++) list = withDismissed(list, `n${i}`)
    assert.equal(list.length, DISMISSED_NOTICE_LIMIT)
    assert.equal(list.at(-1), `n${DISMISSED_NOTICE_LIMIT + 4}`)
    assert.equal(list[0], 'n5')
    assert.deepEqual(withDismissed(['a', 'b'], 'a'), ['a', 'b'])
})

test('a choice is its source, and a stored one its package', () => {
    assert.equal(choiceKey({ source: 'default' }), 'default')
    assert.equal(choiceKey({ source: 'builtin' }), 'builtin')
    assert.equal(choiceKey(fileChoice), 'file:abc')
    assert.equal(choiceKey(serverChoice), 'server:abc')
    assert.equal(choiceKey(bundled), 'bundled:skin2')
})

test('a bundled choice is kept only for the type that has the package', () => {
    const repaired = Value.Repair(previewAssetsSchema, {
        skin: { source: 'bundled', id: 'skin2' },
        particle: { source: 'bundled', id: 'skin2' },
        background: { source: 'bundled', id: 'effect2' },
        effect: { source: 'bundled', id: 'effect2' },
    }) as ReturnType<typeof Value.Create<typeof previewAssetsSchema>>
    assert.deepEqual(repaired.skin, { source: 'bundled', id: 'skin2' })
    assert.deepEqual(repaired.effect, { source: 'bundled', id: 'effect2' })
    assert.deepEqual(repaired.particle, { source: 'default' })
    assert.deepEqual(repaired.background, { source: 'default' })
    const wrong = Value.Repair(previewAssetsSchema, {
        skin: { source: 'bundled', id: 'effect2' },
        effect: { source: 'bundled', id: 'skin2' },
    }) as typeof repaired
    assert.deepEqual(wrong.skin, { source: 'default' })
    assert.deepEqual(wrong.effect, { source: 'default' })
})

test('the stored choices default to Default and repair what cannot be read', () => {
    const defaults = Value.Create(previewAssetsSchema)
    for (const type of ['skin', 'particle', 'background', 'effect'] as const)
        assert.deepEqual(defaults[type], { source: 'default' })
    assert.equal(Value.Check(assetChoiceSchema, { source: 'builtin' }), true)
    assert.equal(Value.Check(assetChoiceSchema, fileChoice), true)
    assert.equal(Value.Check(assetChoiceSchema, { source: 'file' }), false)
    assert.equal(Value.Check(assetChoiceSchema, { source: 'elsewhere' }), false)

    const repaired = Value.Repair(previewAssetsSchema, {
        skin: { source: 'builtin' },
        particle: { source: 'file', key: 1 },
        background: 'nonsense',
    }) as typeof defaults
    assert.deepEqual(repaired.skin, { source: 'builtin' })
    assert.equal(Value.Check(previewAssetsSchema, repaired), true)
    assert.equal(Value.Check(assetChoiceSchema, repaired.particle), true)
    assert.deepEqual(repaired.effect, { source: 'default' })
})

test('Preview Assets joins an unchanged playback group first, and only that', () => {
    const former = [
        'offset',
        'bgm',
        'toggleSfxVolume',
        'toggleBgmVolume',
        'speedUp',
        'speedDown',
        'stop',
        'play',
    ]
    const migrated = insertPreviewAssets([['open'], former, ['undo']])
    assert.deepEqual(migrated, [['open'], ['previewAssets', ...former], ['undo']])
    // A customised playback group is left alone.
    const customised = [['open'], ['bgm', 'play']]
    assert.equal(insertPreviewAssets(customised), customised)
    const reordered = [[...former].reverse()]
    assert.equal(insertPreviewAssets(reordered), reordered)
    // A toolbar that has the command already is left alone.
    const has = [['previewAssets'], former]
    assert.equal(insertPreviewAssets(has), has)
})

test('the footer line counts items with a singular form', () => {
    const message = 'Stored: {0} item, {1}|Stored: {0} items, {1}'
    const size = (bytes: number) => `${bytes / 1000} kB`
    assert.equal(storedLine(message, { count: 0, bytes: 0 }, size), 'Stored: 0 items, 0 kB')
    assert.equal(storedLine(message, { count: 1, bytes: 4200 }, size), 'Stored: 1 item, 4.2 kB')
    assert.equal(storedLine(message, { count: 3, bytes: 14000 }, size), 'Stored: 3 items, 14 kB')
})

test('a value that arrives after an abort is released, not dropped', async () => {
    const controller = new AbortController()
    let closed = 0
    const loader = createAssetLoader({
        defaults: set(async () => {
            controller.abort()
            return { texture: { close: () => closed++ } } as unknown as Loaded['skin']
        }),
    })
    const result = await loader.load(
        'skin',
        { source: 'default' },
        {
            ...context(),
            signal: controller.signal,
        },
    )
    assert.equal(result, undefined)
    assert.equal(closed, 1)
})
