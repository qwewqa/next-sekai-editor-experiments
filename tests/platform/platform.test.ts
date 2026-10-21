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

test('the mock’s journal writes, reads back, clears what a strict flush covers, and removes', async () => {
    const { journal } = createMockPlatform()
    assert.equal(journal.writeWhole({ sessionId: 's', seq: 3 }), true)
    const [found] = await journal.read()
    assert.deepEqual(found, {
        sessionId: 's',
        text: '{"sessionId":"s","seq":3}',
        from: 'journal.s',
    })
    journal.clear('s', 2)
    assert.equal((await journal.read()).length, 1)
    journal.clear('s', 3)
    assert.equal((await journal.read()).length, 0)
    assert.equal(journal.writeWhole({ sessionId: 't', seq: 1 }), true)
    const [kept] = await journal.read()
    assert.ok(kept)
    assert.equal(journal.writeWhole({ sessionId: 't', seq: 2 }), true)
    journal.remove(kept)
    assert.equal((await journal.read()).length, 1)
})

test('locks grant in order and list holders and waiters, on the web and in the mock', async () => {
    for (const platform of [buildPlatform, createMockPlatform()]) {
        const order: string[] = []
        let release!: () => void
        const first = platform.locks.request('nse-test', {}, async (held) => {
            order.push(`first ${String(held)}`)
            await new Promise<void>((resolve) => (release = resolve))
        })
        const busy = await platform.locks.request('nse-test', { ifAvailable: true }, (held) =>
            Promise.resolve(held),
        )
        const second = platform.locks.request('nse-test', { mode: 'shared' }, async (held) => {
            order.push(`second ${String(held)}`)
        })
        const snapshot = await platform.locks.query()
        assert.deepEqual(
            snapshot.held.filter((lock) => lock.name === 'nse-test').map((lock) => lock.mode),
            ['exclusive'],
        )
        assert.deepEqual(
            snapshot.pending.filter((lock) => lock.name === 'nse-test').map((lock) => lock.mode),
            ['shared'],
        )
        assert.equal(busy, false)
        release()
        await Promise.all([first, second])
        assert.deepEqual(order, ['first true', 'second true'])
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
    // The web makes no cross-origin requests: no From a Server.
    assert.equal(capabilities.serverFetch, false)
    assert.ok(Object.isFrozen(capabilities))
})

test('the mock picks the queued files, and nothing when none are left', async () => {
    const mock = createMockPlatform()
    const file = new File(['x'], 'a.json')
    mock.picks.push([{ file }])
    assert.deepEqual(await mock.pickFiles({}), [{ file }])
    assert.deepEqual(await mock.pickFiles({}), [])
})

test('the mock downloads, writes to targets and dismisses its picker', async () => {
    const mock = createMockPlatform()
    const build = () => Promise.resolve(new Blob(['level']))

    assert.deepEqual(await mock.saveFile({ kind: 'nsld', suggestedName: 'LevelData', build }), {
        status: 'download-started',
        name: 'LevelData',
    })
    assert.equal(mock.downloads.length, 1)
    assert.equal(await mock.downloads[0]!.blob.text(), 'level')

    // The save picker alone: dismissed, or a file it empties (D5).
    const picker = { id: 'levelData', types: [] }
    mock.saveTargets.push('cancel')
    assert.equal(await mock.pickSaveFile!({ suggestedName: 'LevelData', picker }), undefined)
    mock.writeFile('picked.nsld', new Blob(['old']))
    mock.saveTargets.push({ kind: 'handle', handle: mock.createHandle('picked.nsld') })
    const picked = await mock.pickSaveFile!({ suggestedName: 'LevelData', picker })
    assert.equal(picked?.kind, 'handle')
    assert.equal(mock.files.get('picked.nsld')?.size, 0)

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
