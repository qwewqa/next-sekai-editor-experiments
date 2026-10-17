import { platform as buildPlatform } from '#platform'
import assert from 'node:assert/strict'
import test from 'node:test'
import * as platformModule from '../../src/platform'
import { createMockPlatform } from '../../src/platform/mock'
import { appVersion, parseVersionOverride } from '../../src/platform/version'

test('index.ts exports the build’s platform as a live binding', () => {
    assert.equal(platformModule.platform, buildPlatform)
    const mock = createMockPlatform({ kind: 'native', os: 'macos' })
    platformModule.setPlatformForTests(mock)
    try {
        assert.equal(platformModule.platform, mock)
        assert.equal(platformModule.platform.kind, 'native')
        assert.equal(platformModule.platform.capabilities.library, true)
    } finally {
        platformModule.setPlatformForTests(undefined)
    }
    assert.equal(platformModule.platform, buildPlatform)
})

test('journal and locks are named stubs until Step 3', async () => {
    for (const platform of [buildPlatform, createMockPlatform()]) {
        assert.throws(() => platform.journal.read('journal.x'), {
            message: 'platform.journal is not available before Step 3',
        })
        assert.throws(() => platform.journal.write('journal.x', ''), /before Step 3/)
        await assert.rejects(
            platform.locks.request('nse', {}, () => Promise.resolve()),
            { message: 'platform.locks is not available before Step 3' },
        )
    }
})

test('the web platform’s capabilities are the web’s set', () => {
    const { capabilities } = buildPlatform
    assert.equal(capabilities.library, false)
    assert.equal(capabilities.fileJournal, false)
    assert.equal(capabilities.updates, 'none')
    assert.equal(capabilities.defaultAssets, true)
    assert.equal(capabilities.browserStorage, true)
    assert.equal(capabilities.safeModeEntry, 'query')
    assert.equal(capabilities.fileAssociations, false)
    assert.ok(Object.isFrozen(capabilities))
})

test('the mock picks the queued files, and nothing when none are left', async () => {
    const mock = createMockPlatform()
    const file = new File(['x'], 'a.json')
    mock.picks.push([{ file }])
    assert.deepEqual(await mock.pickFiles({}), [{ file }])
    assert.deepEqual(await mock.pickFiles({}), [])
})

test('the mock downloads, writes to targets and cancels', async () => {
    const mock = createMockPlatform()
    const build = () => Promise.resolve(new Blob(['level']))

    assert.deepEqual(await mock.saveFile({ kind: 'nsld', suggestedName: 'LevelData', build }), {
        status: 'download-started',
        name: 'LevelData',
    })
    assert.equal(mock.downloads.length, 1)
    assert.equal(await mock.downloads[0]!.blob.text(), 'level')

    mock.saveTargets.push('cancel')
    let built = false
    assert.deepEqual(
        await mock.saveFile({
            kind: 'nsld',
            suggestedName: 'LevelData',
            build: () => {
                built = true
                return build()
            },
        }),
        { status: 'cancelled' },
    )
    assert.equal(built, false)

    const handle = mock.createHandle('chart.nsld')
    const result = await mock.saveFile({
        kind: 'nsld',
        suggestedName: 'LevelData',
        target: { kind: 'handle', handle },
        build,
    })
    assert.equal(result.status, 'saved')
    assert.equal(await (await handle.getFile()).text(), 'level')

    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
        mock.saveFile({
            kind: 'nsld',
            suggestedName: 'LevelData',
            target: { kind: 'path', path: '/a.nsld' },
            signal: controller.signal,
            build,
        }),
        { name: 'AbortError' },
    )
    assert.equal(mock.files.has('/a.nsld'), false)
})

test('the mock asks every close handler and passes lifecycle events', async () => {
    const mock = createMockPlatform()
    let dirty = true
    const stop = mock.onCloseRequested(() => !dirty)
    mock.onCloseRequested(() => Promise.resolve(true))
    assert.equal(await mock.requestClose(), false)
    dirty = false
    assert.equal(await mock.requestClose(), true)
    dirty = true
    stop()
    assert.equal(await mock.requestClose(), true)

    const events: string[] = []
    const stopLifecycle = mock.onLifecycle((e) => {
        events.push(e)
    })
    await mock.emitLifecycle('hide')
    await mock.emitLifecycle('freeze')
    stopLifecycle()
    await mock.emitLifecycle('show')
    assert.deepEqual(events, ['hide', 'freeze'])

    mock.openExternal('https://example.com/')
    assert.deepEqual(mock.external, ['https://example.com/'])
})

test('the mock serves fetchServer from its handler', async () => {
    const mock = createMockPlatform({
        fetch: (url) => Promise.resolve(new Response(url)),
    })
    assert.equal(await (await mock.fetchServer('https://server/a')).text(), 'https://server/a')
    await assert.rejects(createMockPlatform().fetchServer('https://server/a'), TypeError)
})

test('the version override is read whole or not at all', () => {
    assert.deepEqual(parseVersionOverride('{"appVersion":"0.6.0","atTag":true}'), {
        appVersion: '0.6.0',
        atTag: true,
    })
    assert.equal(parseVersionOverride('{"appVersion":"0.6.0"}'), undefined)
    assert.equal(parseVersionOverride('{"appVersion":6,"atTag":true}'), undefined)
    assert.equal(parseVersionOverride('null'), undefined)
    assert.equal(parseVersionOverride('0.6.0'), undefined)
    assert.equal(parseVersionOverride(null), undefined)
    // Node has no build define or override.
    assert.deepEqual(appVersion(), { appVersion: '0.0.0', atTag: true })
})
