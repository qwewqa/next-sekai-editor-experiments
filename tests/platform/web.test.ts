import assert from 'node:assert/strict'
import test from 'node:test'
import { gzip, ungzip } from 'pako'
import { levelDataDiskState } from '../../src/platform/fingerprint'
import { DATA_URL_LIMIT } from '../../src/platform/handover'
import { FileError } from '../../src/platform/types'
import { platform } from '../../src/platform/web'
import { installFakeBrowser, recordingHandle } from './fakeBrowser'

const browser = installFakeBrowser()

const levelBytes = (n = 0) => gzip(JSON.stringify({ bgmOffset: 0, entities: [{ n }] }))

const levelBlob = (n = 0) => new Blob([levelBytes(n)])

const levelData =
    (events: string[], n = 0) =>
    () => {
        events.push('build')
        return Promise.resolve(levelBlob(n))
    }

const parsed = async (blob: Blob) =>
    JSON.parse(
        new TextDecoder().decode(ungzip(new Uint8Array(await blob.arrayBuffer()))),
    ) as unknown

test('saving to a handle asks for permission, writes, closes and reads back', async () => {
    const events: string[] = []
    const handle = recordingHandle(events)
    const result = await platform.saveFile({
        kind: 'nsld',
        suggestedName: 'LevelData',
        target: { kind: 'handle', handle },
        build: levelData(events),
    })
    const disk = await levelDataDiskState(await handle.getFile())
    assert.deepEqual(result, {
        status: 'saved',
        target: { kind: 'handle', handle },
        name: 'chart',
        disk,
    })
    assert.match(disk.fingerprint, /^sha256:[0-9a-f]{64}$/)
    assert.deepEqual(events, [
        'requestPermission',
        'build',
        'create',
        `write:${levelBlob().size}`,
        'close',
    ])
})

test('requestPermission is the first call on the gesture in the Export path', async () => {
    // The gesture's activation ends at the first await; a later call would see it expired.
    let active = true
    const events: string[] = []
    const handle = recordingHandle(events, { initial: levelBlob(), activation: () => active })
    const expected = await levelDataDiskState(await handle.getFile())
    const saving = platform.saveFile({
        kind: 'nsld',
        suggestedName: 'chart',
        target: { kind: 'handle', handle },
        expected,
        replaced: 'discard',
        build: levelData(events, 1),
    })
    active = false
    const result = await saving
    assert.equal(result.status, 'saved')
    assert.equal(events[0], 'requestPermission:active')
})

test('a write with a precondition refuses a changed, missing or present file', async () => {
    const events: string[] = []
    const handle = recordingHandle(events, { initial: levelBlob(0) })
    const expected = await levelDataDiskState(await handle.getFile())

    handle.setContent(levelBlob(2))
    const changed = await levelDataDiskState(await handle.getFile())
    await assert.rejects(
        platform.saveFile({
            kind: 'nsld',
            suggestedName: 'chart',
            target: { kind: 'handle', handle },
            expected,
            build: levelData(events, 1),
        }),
        (error: unknown) =>
            error instanceof FileError &&
            error.code === 'conflict' &&
            error.disk?.fingerprint === changed.fingerprint,
    )
    assert.ok(!events.includes('create'))

    // The same bytes with a new time are the same file.
    handle.setContent(new Blob([levelBytes(0)]))
    assert.equal(
        (
            await platform.saveFile({
                kind: 'nsld',
                suggestedName: 'chart',
                target: { kind: 'handle', handle },
                expected,
                build: levelData(events, 1),
            })
        ).status,
        'saved',
    )

    handle.setContent(undefined)
    await assert.rejects(
        platform.saveFile({
            kind: 'nsld',
            suggestedName: 'chart',
            target: { kind: 'handle', handle },
            expected,
            build: levelData(events, 1),
        }),
        { code: 'not-found' },
    )

    handle.setContent(levelBlob(0))
    await assert.rejects(
        platform.saveFile({
            kind: 'nsld',
            suggestedName: 'chart',
            target: { kind: 'handle', handle },
            expected: 'absent',
            build: levelData(events, 1),
        }),
        { code: 'conflict' },
    )
})

test('a change just before close() aborts the write and leaves the target untouched', async () => {
    const events: string[] = []
    const original = levelBlob(0)
    // Another program writes the file while ours is being written.
    const handle: ReturnType<typeof recordingHandle> = recordingHandle(events, {
        initial: original,
        onWrite: () => {
            handle.setContent(levelBlob(5))
            return Promise.resolve()
        },
    })
    const expected = await levelDataDiskState(original as File)
    await assert.rejects(
        platform.saveFile({
            kind: 'nsld',
            suggestedName: 'chart',
            target: { kind: 'handle', handle },
            expected,
            build: levelData(events, 1),
        }),
        { code: 'conflict' },
    )
    assert.deepEqual(events.slice(-2), [`write:${levelBlob(1).size}`, 'abort'])
    assert.deepEqual(await parsed(await handle.getFile()), { bgmOffset: 0, entities: [{ n: 5 }] })
})

test('a precondition on a file of another size is a conflict found without hashing', async () => {
    const events: string[] = []
    const handle = recordingHandle(events, { initial: levelBlob(0) })
    const expected = await levelDataDiskState(await handle.getFile())
    handle.setContent(new Blob([new Uint8Array(expected.size + 100)]))
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    let hashed = 0
    crypto.subtle.digest = (...args: Parameters<SubtleCrypto['digest']>) => {
        hashed++
        return digest(...args)
    }
    try {
        await assert.rejects(
            platform.saveFile({
                kind: 'nsld',
                suggestedName: 'chart',
                target: { kind: 'handle', handle },
                expected,
                build: levelData(events, 1),
            }),
            (error: unknown) =>
                error instanceof FileError && error.code === 'conflict' && !error.disk,
        )
    } finally {
        crypto.subtle.digest = digest
    }
    assert.equal(hashed, 0)
})

test('a download’s Blob URL outlasts a late iOS prompt, until the page hides', async () => {
    browser.downloads.length = 0
    const revoked: string[] = []
    const revoke = URL.revokeObjectURL.bind(URL)
    URL.revokeObjectURL = (url) => {
        revoked.push(url)
        revoke(url)
    }
    const timer = globalThis.setTimeout
    const delays: number[] = []
    globalThis.setTimeout = ((handler: () => void, delay?: number) => {
        delays.push(delay ?? 0)
        return timer(handler, delay)
    }) as typeof setTimeout
    try {
        await platform.saveFile({ kind: 'nsld', suggestedName: 'LevelData', build: levelData([]) })
    } finally {
        globalThis.setTimeout = timer
    }
    const { href } = browser.downloads[0]!
    assert.ok(delays.every((delay) => delay >= 5 * 60_000))
    assert.deepEqual(revoked, [])
    browser.window.dispatchEvent(new Event('pagehide'))
    assert.deepEqual(revoked, [href])
    URL.revokeObjectURL = revoke
})

test('a write that does not read back as written fails', async () => {
    const events: string[] = []
    const handle = recordingHandle(events, {
        initial: levelBlob(0),
        readBack: () => levelBlob(9),
    })
    const expected = await levelDataDiskState(await handle.getFile())
    await assert.rejects(
        platform.saveFile({
            kind: 'nsld',
            suggestedName: 'chart',
            target: { kind: 'handle', handle },
            expected,
            build: levelData(events, 1),
        }),
        { code: 'io', step: 'readBack' },
    )
})

test('a denied permission is denied, never not-found', async () => {
    const events: string[] = []
    const handle = recordingHandle(events, { initial: levelBlob(0), permission: 'denied' })
    await assert.rejects(
        platform.saveFile({
            kind: 'nsld',
            suggestedName: 'chart',
            target: { kind: 'handle', handle },
            expected: await levelDataDiskState(await handle.getFile()),
            build: levelData(events, 1),
        }),
        { code: 'denied' },
    )
    assert.deepEqual(events, ['requestPermission'])
})

test('built level data that does not gunzip and parse is never written', async () => {
    const events: string[] = []
    const handle = recordingHandle(events, { initial: levelBlob(0) })
    await assert.rejects(
        platform.saveFile({
            kind: 'nsld',
            suggestedName: 'chart',
            target: { kind: 'handle', handle },
            expected: await levelDataDiskState(await handle.getFile()),
            build: () => Promise.resolve(new Blob(['not level data'])),
        }),
        { code: 'io' },
    )
    assert.ok(!events.includes('create'))
})

test('level data builds before opening the save picker, with the picker’s id and types', async () => {
    const events: string[] = []
    const handle = recordingHandle(events)
    const pickers: unknown[] = []
    browser.window.showSaveFilePicker = (options) => {
        pickers.push(options)
        events.push('picker')
        return Promise.resolve(handle)
    }
    try {
        const result = await platform.saveFile({
            kind: 'nsld',
            suggestedName: 'LevelData',
            build: levelData(events),
        })
        assert.equal(result.status, 'saved')
        assert.deepEqual(events.slice(0, 2), ['build', 'picker'])
        await platform.saveFile({
            kind: 'nsld',
            suggestedName: 'Coconut.nsld',
            picker: {
                id: 'levelData',
                types: [{ description: 'Next SEKAI level data', extension: '.nsld' }],
            },
            build: levelData(events),
        })
        assert.deepEqual(pickers, [
            { id: 'levelData', suggestedName: 'LevelData' },
            {
                id: 'levelData',
                suggestedName: 'Coconut.nsld',
                types: [
                    {
                        description: 'Next SEKAI level data',
                        accept: { 'application/octet-stream': ['.nsld'] },
                    },
                ],
                excludeAcceptAllOption: false,
            },
        ])
    } finally {
        delete browser.window.showSaveFilePicker
    }
})

test('a picked file the caller refuses is not written', async () => {
    const events: string[] = []
    const handle = recordingHandle(events)
    browser.window.showSaveFilePicker = () => Promise.resolve(handle)
    try {
        const result = await platform.saveFile({
            kind: 'nsld',
            suggestedName: 'LevelData',
            picker: { id: 'levelData', types: [] },
            build: levelData(events),
            picked: (target) => {
                assert.deepEqual(target, { kind: 'handle', handle })
                return Promise.resolve(false)
            },
        })
        assert.deepEqual(result, { status: 'cancelled' })
        assert.deepEqual(events, ['build'])
    } finally {
        delete browser.window.showSaveFilePicker
    }
})

test('dismissing the save picker cancels without downloading', async () => {
    const events: string[] = []
    browser.downloads.length = 0
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

test('a download is application/octet-stream, in this context only off iOS', async () => {
    browser.downloads.length = 0
    browser.window.showSaveFilePicker = () => Promise.reject(new Error('Not used'))
    try {
        assert.deepEqual(
            await platform.saveFile({
                kind: 'image',
                suggestedName: 'cover.png',
                build: () => Promise.resolve(new Blob(['png'], { type: 'image/png' })),
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
        browser.downloads.map(({ name, type, target }) => ({ name, type, target })),
        [
            { name: 'cover.png', type: 'application/octet-stream', target: '' },
            { name: 'LevelData', type: 'application/octet-stream', target: '' },
        ],
    )
    assert.deepEqual(await parsed(browser.downloads[1]!.blob!), {
        bgmOffset: 0,
        entities: [{ n: 0 }],
    })
})

test('without anchor downloads, a new context opens, then a data: URL below 1 MB', async () => {
    browser.downloads.length = 0
    browser.opened.length = 0
    const anchors = Object.getOwnPropertyDescriptor(globalThis, 'HTMLAnchorElement')
    // A browser whose anchors have no download attribute.
    Object.defineProperty(globalThis, 'HTMLAnchorElement', {
        configurable: true,
        value: class {},
    })
    const open = browser.window.open
    try {
        browser.window.open = (...args) => {
            browser.opened.push(args)
            return {}
        }
        await platform.saveFile({ kind: 'nsld', suggestedName: 'a', build: levelData([]) })
        assert.equal(browser.opened.length, 1)
        assert.match(String(browser.opened[0]![0]), /^blob:/)
        assert.equal(browser.opened[0]![1], '_blank')
        assert.equal(browser.downloads.length, 0)

        // A blocked window falls back to a data: URL, always in a new context.
        browser.window.open = () => null
        await platform.saveFile({ kind: 'nsld', suggestedName: 'b', build: levelData([]) })
        assert.equal(browser.downloads.length, 1)
        assert.match(browser.downloads[0]!.href, /^data:application\/octet-stream;base64,/)
        assert.equal(browser.downloads[0]!.target, '_blank')

        // With no path left, it fails rather than saying the download started.
        browser.downloads.length = 0
        await assert.rejects(
            platform.saveFile({
                kind: 'image',
                suggestedName: 'big.png',
                build: () => Promise.resolve(new Blob([new Uint8Array(DATA_URL_LIMIT)])),
            }),
            (error: unknown) =>
                error instanceof FileError && error.code === 'io' && error.step === 'download',
        )
        assert.equal(browser.downloads.length, 0)
    } finally {
        browser.window.open = open
        if (anchors) Object.defineProperty(globalThis, 'HTMLAnchorElement', anchors)
        else delete (globalThis as { HTMLAnchorElement?: unknown }).HTMLAnchorElement
    }
})

test('a failed write without a precondition aborts the stream and downloads instead', async () => {
    browser.downloads.length = 0
    const events: string[] = []
    const result = await platform.saveFile({
        kind: 'nsld',
        suggestedName: 'LevelData',
        target: { kind: 'handle', handle: recordingHandle(events, { failWrite: true }) },
        build: levelData(events),
    })
    assert.deepEqual(result, { status: 'download-started', name: 'LevelData' })
    assert.deepEqual(events, [
        'requestPermission',
        'build',
        'create',
        `write:${levelBlob().size}`,
        'abort',
        'build',
    ])
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
    assert.deepEqual(events, [
        'requestPermission',
        'build',
        'create',
        `write:${levelBlob().size}`,
        'abort',
    ])
    assert.equal(browser.downloads.length, 0)
})

test('write plans wait for Step 6; inspect and read take handles', async () => {
    await assert.rejects(
        platform.saveFile({
            kind: 'image',
            suggestedName: 'cover.png',
            build: () => Promise.resolve({ kind: 'plan' }),
        }),
        /before Step 6/,
    )
    await assert.rejects(platform.inspect({ kind: 'path', path: 'a' }), /No file paths/)

    const handle = recordingHandle([], { initial: levelBlob(3) })
    const target = { kind: 'handle', handle } as const
    assert.deepEqual(
        await platform.inspect(target),
        await levelDataDiskState(await handle.getFile()),
    )
    assert.deepEqual(await parsed(await platform.read(target)), {
        bgmOffset: 0,
        entities: [{ n: 3 }],
    })
    handle.setContent(undefined)
    assert.equal(await platform.inspect(target), 'missing')
    await assert.rejects(platform.read(target), { code: 'not-found' })
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
