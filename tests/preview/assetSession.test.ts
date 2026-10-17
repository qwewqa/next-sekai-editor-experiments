import assert from 'node:assert/strict'
import test from 'node:test'
import { shallowRef } from 'vue'
import { createAssetLoader } from '../../src/preview/assets/loader'
import { createAssetSession } from '../../src/preview/assets/session'
import {
    AssetError,
    type AssetChoice,
    type AssetDefaults,
    type AssetType,
    type Loaded,
} from '../../src/preview/assets/types'

// The session is built on a fake loader and a choices ref; nothing here imports the web defaults.
const choices = (overrides: Partial<Record<AssetType, AssetChoice>> = {}) =>
    shallowRef<Record<AssetType, AssetChoice>>({
        skin: { source: 'default' },
        particle: { source: 'default' },
        background: { source: 'default' },
        effect: { source: 'default' },
        ...overrides,
    })

const bitmap = () => {
    const texture = {
        closed: 0,
        close() {
            this.closed++
        },
    }
    return texture
}
const skinOf = (title: string) => ({ title, texture: bitmap() }) as unknown as Loaded['skin']
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const deferred = <T>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((r) => (resolve = r))
    return { promise, resolve }
}

const sessionOf = (
    defaults: Partial<AssetDefaults>,
    ref = choices(),
    builtin?: Partial<AssetDefaults>,
) => {
    const never = async () => undefined
    const all = (provided: Partial<AssetDefaults>): AssetDefaults => ({
        skin: never,
        particle: never,
        background: never,
        effect: never,
        ...provided,
    })
    const loader = createAssetLoader({
        defaults: all(defaults),
        builtin: builtin && all(builtin),
    })
    return {
        ref,
        session: createAssetSession({
            loader,
            choices: () => ref.value,
            decodeAudio: async () => ({}) as AudioBuffer,
        }),
    }
}

test('a type loads once on first use and shows its value and status', async () => {
    let calls = 0
    const { session } = sessionOf({
        skin: async () => {
            calls++
            return skinOf('one')
        },
    })
    assert.equal(session.slots.skin.value.state, 'idle')
    session.ensure('skin')
    session.ensure('skin')
    assert.equal(session.slots.skin.value.state, 'loading')
    await flush()
    session.ensure('skin')
    assert.equal(calls, 1)
    assert.equal(session.slots.skin.value.state, 'ready')
    assert.equal(session.slots.skin.value.value?.title, 'one')
    assert.equal(session.slots.skin.value.status?.active, 'default')
})

test('switching closes the old ImageBitmap, once the new one is shown', async () => {
    const first = skinOf('default')
    const second = skinOf('built-in')
    const gate = deferred<Loaded['skin']>()
    const { session, ref } = sessionOf({ skin: async () => first }, choices(), {
        skin: () => gate.promise,
    })
    session.ensure('skin')
    await flush()
    assert.equal(session.slots.skin.value.value, first)

    ref.value = { ...ref.value, skin: { source: 'builtin' } }
    // The old skin keeps showing while the new one loads.
    assert.equal(session.slots.skin.value.state, 'ready')
    assert.equal(session.slots.skin.value.value, first)
    assert.equal((first.texture as unknown as { closed: number }).closed, 0)

    gate.resolve(second)
    await flush()
    assert.equal(session.slots.skin.value.value, second)
    assert.equal((first.texture as unknown as { closed: number }).closed, 1)
    assert.equal((second.texture as unknown as { closed: number }).closed, 0)
    assert.deepEqual(session.slots.skin.value.status, { active: 'builtin' })
})

test('a choice change reloads only the types that were asked for', async (t) => {
    t.mock.method(console, 'error', () => {})
    const asked: string[] = []
    const { session, ref } = sessionOf({
        skin: async () => (asked.push('skin'), skinOf('s')),
        particle: async () => (asked.push('particle'), undefined),
    })
    session.ensure('skin')
    await flush()
    ref.value = {
        ...ref.value,
        skin: { source: 'builtin' },
        particle: { source: 'builtin' },
    }
    await flush()
    assert.deepEqual(asked, ['skin', 'skin'])
    assert.equal(session.slots.particle.value.state, 'idle')
})

test('a replaced load that finishes late is not shown and closes nothing shown', async (t) => {
    t.mock.method(console, 'error', () => {})
    const late = deferred<Loaded['skin']>()
    const shown = skinOf('shown')
    let call = 0
    const { session, ref } = sessionOf({
        skin: () => (call++ === 0 ? late.promise : Promise.resolve(shown)),
    })
    session.ensure('skin')
    ref.value = { ...ref.value, skin: { source: 'builtin' } }
    // The builtin choice has no provider here, so Default answers the second request.
    await flush()
    assert.equal(session.slots.skin.value.value, shown)
    late.resolve(skinOf('stale'))
    await flush()
    assert.equal(session.slots.skin.value.value, shown)
    assert.equal((shown.texture as unknown as { closed: number }).closed, 0)
})

test('a failing chain shows failed, keeps the error, and retries', async () => {
    let fail = true
    const { session } = sessionOf({
        skin: async () => {
            if (fail) throw new AssetError('unavailable', 'HTTP 503')
            return skinOf('back')
        },
    })
    session.ensure('skin')
    await flush()
    assert.equal(session.slots.skin.value.state, 'failed')
    assert.match(String((session.slots.skin.value.error as Error).message), /HTTP 503/)
    fail = false
    session.retry('skin')
    await flush()
    assert.equal(session.slots.skin.value.state, 'ready')
    // Retrying a shown type does nothing.
    session.retry('skin')
    assert.equal(session.slots.skin.value.state, 'ready')
})

test('a failed switch keeps the shown asset', async (t) => {
    t.mock.method(console, 'error', () => {})
    const first = skinOf('default')
    const { session, ref } = sessionOf({ skin: async () => first }, choices(), {
        skin: async () => {
            throw new Error('gone')
        },
    })
    session.ensure('skin')
    await flush()
    // Built-in fails and Default shows again: the same asset, not closed.
    ref.value = { ...ref.value, skin: { source: 'builtin' } }
    await flush()
    assert.equal(session.slots.skin.value.value, first)
    assert.equal((first.texture as unknown as { closed: number }).closed, 0)
    assert.equal(session.slots.skin.value.status?.active, 'default')
    assert.equal(session.slots.skin.value.status?.reason, 'corrupt')
})

test('a background releases its object URL when replaced, and dispose closes everything', async () => {
    const released: string[] = []
    const backgroundOf = (url: string) =>
        ({
            url,
            aspectRatio: 16 / 9,
            fit: 'cover',
            color: 'transparent',
            blur: 0,
            mask: undefined,
            dispose: () => released.push(url),
        }) as Loaded['background']
    const skin = skinOf('s')
    const { session, ref } = sessionOf(
        { background: async () => backgroundOf('default'), skin: async () => skin },
        choices(),
        { background: async () => backgroundOf('built-in') },
    )
    session.ensure('background')
    session.ensure('skin')
    await flush()
    ref.value = { ...ref.value, background: { source: 'builtin' } }
    await flush()
    assert.deepEqual(released, ['default'])

    session.dispose()
    assert.deepEqual(released, ['default', 'built-in'])
    assert.equal((skin.texture as unknown as { closed: number }).closed, 1)
    assert.equal(session.slots.background.value.state, 'idle')
})

test('a switch that fails everywhere keeps the shown asset, reports it, and can be retried', async (t) => {
    t.mock.method(console, 'error', () => {})
    let offline = false
    const first = skinOf('default')
    const second = skinOf('built-in')
    const { session, ref } = sessionOf(
        {
            skin: async () => {
                if (offline) throw new AssetError('unavailable', 'HTTP 503')
                return first
            },
        },
        choices(),
        {
            skin: async () => {
                if (offline) throw new AssetError('unavailable', 'HTTP 503')
                return second
            },
        },
    )
    session.ensure('skin')
    await flush()
    offline = true
    ref.value = { ...ref.value, skin: { source: 'builtin' } }
    await flush()
    const slot = session.slots.skin.value
    assert.equal(slot.state, 'ready')
    assert.equal(slot.value, first)
    assert.deepEqual(slot.choice, { source: 'builtin' })
    assert.deepEqual(slot.status, { active: 'default', reason: 'unavailable' })
    assert.equal(slot.stale, true)

    offline = false
    session.retry('skin')
    await flush()
    assert.equal(session.slots.skin.value.value, second)
    assert.equal(session.slots.skin.value.stale, undefined)
    assert.deepEqual(session.slots.skin.value.status, { active: 'builtin' })
    assert.equal((first.texture as unknown as { closed: number }).closed, 1)
})
