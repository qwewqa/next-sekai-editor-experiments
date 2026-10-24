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

const levelJson = (n: number) => ({ bgmOffset: 0, entities: [{ n }] })

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

test('the save picker alone passes its id, types and folder, and a dismissal is undefined', async () => {
    const events: string[] = []
    const handle = recordingHandle(events)
    const pickers: unknown[] = []
    browser.window.showSaveFilePicker = (options) => {
        pickers.push(options)
        // A save picker empties the file it returns (D5).
        handle.setContent(new Blob([]))
        return Promise.resolve(handle)
    }
    try {
        assert.deepEqual(
            await platform.pickSaveFile!({
                suggestedName: 'Coconut.nsld',
                picker: {
                    id: 'levelData',
                    types: [{ description: 'Next SEKAI level data', extension: '.nsld' }],
                },
            }),
            { kind: 'handle', handle },
        )
        assert.deepEqual(pickers, [
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
        browser.window.showSaveFilePicker = () =>
            Promise.reject(new DOMException('Dismissed', 'AbortError'))
        assert.equal(
            await platform.pickSaveFile!({
                suggestedName: 'LevelData',
                picker: { id: 'levelData', types: [] },
            }),
            undefined,
        )
        // Building and writing are the caller's: a save without a target never opens it.
        browser.downloads.length = 0
        events.length = 0
        assert.deepEqual(
            await platform.saveFile({
                kind: 'nsld',
                suggestedName: 'LevelData',
                build: levelData(events),
            }),
            { status: 'download-started', name: 'LevelData' },
        )
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

test('an AbortError with no cancel is a failure naming the file, never a cancel', async () => {
    const events: string[] = []
    // As Chromium's close() rejects when a check blocks the write.
    const handle = recordingHandle(events, {
        initial: levelBlob(0),
        failClose: new DOMException('Blocked', 'AbortError'),
    })
    await assert.rejects(
        platform.saveFile({
            kind: 'nsld',
            suggestedName: 'Other',
            target: { kind: 'handle', handle },
            expected: await levelDataDiskState(await handle.getFile()),
            signal: new AbortController().signal,
            build: levelData(events, 1),
        }),
        (error: unknown) =>
            error instanceof FileError && error.code === 'io' && error.fileName === 'chart',
    )
    assert.deepEqual(await parsed(await handle.getFile()), levelJson(0))
})

test('a write plan is executed before it is handed over; inspect and read take handles', async () => {
    const result = await platform.saveFile({
        kind: 'image',
        suggestedName: 'cover.png',
        build: () =>
            Promise.resolve({
                kind: 'zip',
                plan: {
                    modified: { dosTime: 0, dosDate: 33 },
                    entries: [
                        {
                            name: 'a',
                            method: 0,
                            parts: [{ kind: 'bytes', data: new Uint8Array([1]) }],
                        },
                    ],
                },
            }),
    })
    assert.deepEqual(result, { status: 'download-started', name: 'cover.png' })
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
    let returnValue: unknown
    const close = () => {
        const event: Event & { returnValue?: unknown } = new Event('beforeunload', {
            cancelable: true,
        })
        // A BeforeUnloadEvent's returnValue is its own field, not Event's legacy flag.
        Object.defineProperty(event, 'returnValue', { value: undefined, writable: true })
        browser.window.dispatchEvent(event)
        returnValue = event.returnValue
        return event.defaultPrevented
    }
    assert.equal(close(), true)
    // Chrome and Edge before 119 show the prompt only for returnValue.
    assert.equal(returnValue, true)
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

test('fetchServer fetches nothing on the web', async () => {
    const original = globalThis.fetch
    let fetched = false
    globalThis.fetch = () => {
        fetched = true
        return Promise.resolve(new Response())
    }
    try {
        await assert.rejects(platform.fetchServer('https://server/a'))
        assert.equal(fetched, false)
    } finally {
        globalThis.fetch = original
    }
})
