import assert from 'node:assert/strict'
import test from 'node:test'
import { platform } from '../../src/platform/web'
import { installFakeBrowser, recordingHandle } from './fakeBrowser'

const browser = installFakeBrowser()

const levelData = (events: string[]) => () => {
    events.push('build')
    return Promise.resolve(new Blob(['level']))
}

test('saving to a handle writes, then closes', async () => {
    const events: string[] = []
    const handle = recordingHandle(events)
    const result = await platform.saveFile({
        kind: 'nsld',
        suggestedName: 'LevelData',
        target: { kind: 'handle', handle },
        build: levelData(events),
    })
    assert.deepEqual(result, { status: 'saved', target: { kind: 'handle', handle }, name: 'chart' })
    assert.deepEqual(events, ['build', 'create', 'write:level', 'close'])
})

test('level data builds before opening the save picker', async () => {
    const events: string[] = []
    const handle = recordingHandle(events)
    browser.window.showSaveFilePicker = (options) => {
        events.push(`picker:${options.id}:${options.suggestedName}`)
        return Promise.resolve(handle)
    }
    try {
        const result = await platform.saveFile({
            kind: 'nsld',
            suggestedName: 'LevelData',
            build: levelData(events),
        })
        assert.equal(result.status, 'saved')
        assert.deepEqual(events, [
            'build',
            'picker:levelData:LevelData',
            'create',
            'write:level',
            'close',
        ])
    } finally {
        delete browser.window.showSaveFilePicker
    }
})

test('dismissing the save picker cancels without downloading', async () => {
    const events: string[] = []
    browser.window.showSaveFilePicker = () =>
        Promise.reject(new DOMException('Dismissed', 'AbortError'))
    try {
        const result = await platform.saveFile({
            kind: 'nsld',
            suggestedName: 'LevelData',
            build: levelData(events),
        })
        assert.deepEqual(result, { status: 'cancelled' })
        assert.deepEqual(events, ['build'])
        assert.equal(browser.downloads.length, 0)
    } finally {
        delete browser.window.showSaveFilePicker
    }
})

test('without a picker, and for files other than level data, the file downloads', async () => {
    browser.downloads.length = 0
    browser.window.showSaveFilePicker = () => Promise.reject(new Error('Not used'))
    try {
        const events: string[] = []
        assert.deepEqual(
            await platform.saveFile({
                kind: 'image',
                suggestedName: 'cover.png',
                build: levelData(events),
            }),
            { status: 'download-started', name: 'cover.png' },
        )
    } finally {
        delete browser.window.showSaveFilePicker
    }
    assert.deepEqual(
        await platform.saveFile({
            kind: 'nsld',
            suggestedName: 'LevelData',
            build: levelData([]),
        }),
        { status: 'download-started', name: 'LevelData' },
    )
    assert.deepEqual(
        browser.downloads.map(({ name }) => name),
        ['cover.png', 'LevelData'],
    )
    assert.equal(await browser.downloads[1]!.text, 'level')
})

test('a failed write aborts the stream and downloads instead', async () => {
    browser.downloads.length = 0
    const events: string[] = []
    const result = await platform.saveFile({
        kind: 'nsld',
        suggestedName: 'LevelData',
        target: { kind: 'handle', handle: recordingHandle(events, { failWrite: true }) },
        build: levelData(events),
    })
    assert.deepEqual(result, { status: 'download-started', name: 'LevelData' })
    assert.deepEqual(events, ['build', 'create', 'write:level', 'abort'])
    assert.equal(browser.downloads.length, 1)
})

test('cancelling during a write aborts it without a download', async () => {
    browser.downloads.length = 0
    const events: string[] = []
    const controller = new AbortController()
    const handle = recordingHandle(events, {
        onWrite: () => {
            controller.abort()
            return Promise.resolve()
        },
    })
    await assert.rejects(
        platform.saveFile({
            kind: 'nsld',
            suggestedName: 'LevelData',
            target: { kind: 'handle', handle },
            signal: controller.signal,
            build: levelData(events),
        }),
        { name: 'AbortError' },
    )
    assert.deepEqual(events, ['build', 'create', 'write:level', 'abort'])
    assert.equal(browser.downloads.length, 0)
})

test('preconditions and write plans wait for their steps', async () => {
    await assert.rejects(
        platform.saveFile({
            kind: 'nsld',
            suggestedName: 'LevelData',
            expected: 'absent',
            build: levelData([]),
        }),
        /before Step 1c/,
    )
    await assert.rejects(
        platform.saveFile({
            kind: 'image',
            suggestedName: 'cover.png',
            build: () => Promise.resolve({ kind: 'plan' }),
        }),
        /before Step 6/,
    )
    await assert.rejects(platform.inspect({ kind: 'path', path: 'a' }), /before Step 1c/)
})

test('picking with handles uses the open picker, and a failure is a cancel', async () => {
    const file = new File(['x'], 'chart.json')
    const handle = { getFile: () => Promise.resolve(file) }
    browser.window.showOpenFilePicker = (options) => {
        assert.deepEqual(options, { id: 'levelData' })
        return Promise.resolve([handle])
    }
    try {
        assert.deepEqual(await platform.pickFiles({ id: 'levelData', handles: true }), [
            { file, handle },
        ])
        browser.window.showOpenFilePicker = () => Promise.reject(new Error('Blocked'))
        assert.deepEqual(await platform.pickFiles({ id: 'levelData', handles: true }), [])
    } finally {
        delete browser.window.showOpenFilePicker
    }
})

test('picking without handles uses a file input', async () => {
    const file = new File(['x'], 'cover.png')
    browser.setInputFile(file)
    assert.deepEqual(await platform.pickFiles({}), [{ file }])
    browser.setInputFile(undefined)
    assert.deepEqual(await platform.pickFiles({}), [])
})

test('a close handler keeps the page only by answering false synchronously', () => {
    let answer: boolean | Promise<boolean> = false
    const stop = platform.onCloseRequested(() => answer)
    const close = () => {
        const event = new Event('beforeunload', { cancelable: true })
        browser.window.dispatchEvent(event)
        return event.defaultPrevented
    }
    assert.equal(close(), true)
    answer = true
    assert.equal(close(), false)
    answer = Promise.resolve(false)
    assert.equal(close(), false)
    answer = false
    stop()
    assert.equal(close(), false)
})

test('lifecycle events come from visibilitychange, pagehide and freeze', () => {
    const events: string[] = []
    const stop = platform.onLifecycle((e) => {
        events.push(e)
    })
    browser.document.visibilityState = 'hidden'
    browser.document.dispatchEvent(new Event('visibilitychange'))
    browser.window.dispatchEvent(new Event('pagehide'))
    browser.document.dispatchEvent(new Event('freeze'))
    browser.document.visibilityState = 'visible'
    browser.document.dispatchEvent(new Event('visibilitychange'))
    stop()
    browser.window.dispatchEvent(new Event('pagehide'))
    assert.deepEqual(events, ['hide', 'hide', 'freeze', 'show'])
})

test('external links open a new tab with noopener, never a Blob or data: URL', () => {
    browser.opened.length = 0
    platform.openExternal('https://github.com/')
    assert.deepEqual(browser.opened, [['https://github.com/', '_blank', 'noopener']])
    assert.throws(() => platform.openExternal('blob:https://nse/1'))
    assert.throws(() => platform.openExternal(' data:text/plain,x'))
    assert.equal(browser.opened.length, 1)
})

test('fetchServer is fetch', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (input) => Promise.resolve(new Response(String(input)))
    try {
        assert.equal(
            await (await platform.fetchServer('https://server/a')).text(),
            'https://server/a',
        )
    } finally {
        globalThis.fetch = original
    }
})
