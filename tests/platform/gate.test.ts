import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { ungzip } from 'pako'
import { serializeAutoSave } from '../../src/history/autoSave/serialize'
import { toRecoveryFile } from '../../src/history/autoSave/unreadable'
import { journalContent, journalLevelData } from '../../src/local/journal/content'
import { JOURNAL_VERSION, readJournal, type JournalV1 } from '../../src/local/journal/format'
import { MemoryStorage } from '../../src/local/journal/store'
import { RECORDS_V, SESSION_V } from '../../src/local/records/version'
import { detectFromUa } from '../../src/platform/detect'
import { storageKey } from '../../src/storage'
import { goldenChart, stateOf } from '../local/records/charts'

// The support gate (Part 1 §1.6.10, §1.6.11.3): public/gate.js is plain ES5 that runs before the
// bundle, so it reads the stored formats on its own. These tests run it in Node, with a fake
// window, and check that what it offers is what the bundle's own readers and writers say.

const source = readFileSync('public/gate.js', 'utf8')

type GateFile = { name: string; type: string; data: string | Uint8Array; label?: string }
type Gate = {
    PREFIX: string
    missingFeatures: (win: object) => string[]
    isWebKit: (win: object) => boolean
    message: (win: object) => string
    toRecoveryFile: (text: string) => GateFile
    journalFile: (text: string) => (GateFile & { writtenAt?: number }) | undefined
    recoveryFiles: (storage: MemoryStorage) => GateFile[]
    run: (win: FakeWindow) => boolean
}

// The script as the browser runs it, with `module` defined so that it exports instead of running.
const loadGate = (): Gate => {
    const context = { module: { exports: {} as unknown }, atob }
    vm.runInNewContext(source, context)
    const loaded = context.module.exports as Gate
    // Arrays made in the script’s realm compare as foreign to deepEqual.
    return {
        ...loaded,
        missingFeatures: (win) => Array.from(loaded.missingFeatures(win)),
        recoveryFiles: (storage) => Array.from(loaded.recoveryFiles(storage)),
    }
}

const gate = loadGate()

const prefix = 'sonolus-next-sekai-editor.'

// The gate names a day and a time in the viewer’s zone, in English.
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const day = (time: number) => `${months[new Date(time).getMonth()]} ${new Date(time).getDate()}`
const clock = (time: number) => {
    const date = new Date(time)
    const two = (n: number) => String(n).padStart(2, '0')
    return `${day(time)} ${two(date.getHours())}:${two(date.getMinutes())}`
}

const bytesOf = (data: string | Uint8Array) =>
    typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)

test('the gate is plain ES5', async (t) => {
    const acorn = await import('acorn').catch(() => undefined)
    if (!acorn) return t.skip('acorn is not installed')
    // Parsing at ecmaVersion 5 rejects arrow functions, let, const, template strings and the rest.
    assert.doesNotThrow(() => acorn.parse(source, { ecmaVersion: 5, sourceType: 'script' }))
    assert.throws(() => acorn.parse('const a = () => 1', { ecmaVersion: 5 }))
})

test('the gate reads the keys under the editor’s own prefix', () => {
    assert.equal(gate.PREFIX, storageKey(''))
    assert.equal(gate.PREFIX, prefix)
})

// A window with only what the check looks at.
const modern = () => ({
    indexedDB: {},
    navigator: { storage: { estimate: () => undefined }, locks: {}, userAgent: '' },
    OffscreenCanvas: class {},
    structuredClone: () => undefined,
})

test('a missing feature is found', () => {
    assert.deepEqual(gate.missingFeatures(modern()), [])
    const without = (change: (win: ReturnType<typeof modern>) => void) => {
        const win = modern()
        change(win)
        return gate.missingFeatures(win)
    }
    assert.deepEqual(
        without((win) => delete (win as Partial<typeof win>).indexedDB),
        ['indexedDB'],
    )
    assert.deepEqual(
        without((win) => ((win.navigator.storage as { estimate?: unknown }).estimate = undefined)),
        ['navigator.storage.estimate'],
    )
    assert.deepEqual(
        without((win) => ((win.navigator as { storage?: unknown }).storage = undefined)),
        ['navigator.storage.estimate'],
    )
    assert.deepEqual(
        without((win) => ((win.navigator as { locks?: unknown }).locks = undefined)),
        ['navigator.locks'],
    )
    assert.deepEqual(
        without((win) => delete (win as Partial<typeof win>).OffscreenCanvas),
        ['OffscreenCanvas'],
    )
    assert.deepEqual(
        without((win) => delete (win as Partial<typeof win>).structuredClone),
        ['structuredClone'],
    )
    assert.deepEqual(gate.missingFeatures({}), [
        'indexedDB',
        'navigator.storage.estimate',
        'navigator.locks',
        'OffscreenCanvas',
        'structuredClone',
    ])
})

const uas = {
    iphoneSafari:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    iphoneChrome:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1',
    ipadDesktop:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15',
    macSafari:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15',
    macChrome:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    macFirefox:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0',
    windowsChrome:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    windowsEdge:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    androidChrome:
        'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0',
}

test('the wording follows the platform module’s WebKit rule, on every user agent', () => {
    for (const [name, userAgent] of Object.entries(uas)) {
        for (const touch of [0, 5]) {
            for (const gestureEvent of [false, true]) {
                const win: Record<string, unknown> = {
                    navigator: { userAgent, maxTouchPoints: touch },
                }
                if (gestureEvent) win.GestureEvent = class {}
                const webkit =
                    detectFromUa({ userAgent, maxTouchPoints: touch, gestureEvent }).engine ===
                    'webkit'
                assert.equal(
                    gate.isWebKit(win),
                    webkit,
                    `${name} touch ${touch} gesture ${gestureEvent}`,
                )
                assert.equal(
                    gate.message(win),
                    webkit
                        ? 'This editor needs Safari 17 or later.'
                        : 'This browser is too old for the editor.',
                )
            }
        }
    }
})

// The auto save in the three forms its schema takes, and text that is neither.
const levelData = journalLevelData(journalContent(stateOf(goldenChart())))
const v1 = JSON.stringify(serializeAutoSave(levelData, 'coconut', { defaultGuideColors: [12, 40] }))
const v1Unnamed = JSON.stringify(serializeAutoSave(levelData))
const raw = JSON.stringify(levelData)
const notGzip = JSON.stringify({ version: 1, levelData: btoa('hello') })
const badBase64 = JSON.stringify({ version: 1, levelData: '!!!' })
const texts = {
    v1,
    v1Unnamed,
    raw,
    notGzip,
    badBase64,
    damaged: v1.slice(0, 40),
    array: '[1,2]',
    number: '3',
    empty: '',
}

test('the gate offers an old auto save as the bundle’s recovery file does, in each form', async () => {
    for (const [name, text] of Object.entries(texts)) {
        const real = toRecoveryFile(text)
        const mine = gate.toRecoveryFile(text)
        assert.deepEqual(
            bytesOf(mine.data),
            Buffer.from(await real.blob.arrayBuffer()),
            `${name} bytes`,
        )
        // A level file keeps its `.nsld` or `.json` extension; the rest is the stored text.
        if (real.blob.type === 'text/plain') assert.equal(mine.name, 'Recovery.txt', name)
        assert.equal(mine.type === 'text/plain', real.blob.type === 'text/plain', `${name} type`)
        if (real.blob.type === 'application/json') assert.equal(mine.name, real.name, name)
        if (real.blob.type === 'application/octet-stream')
            assert.equal(mine.name, `${real.name}.nsld`, name)
    }
    // The v1 form is the gzipped level data, which decodes to the chart.
    const file = gate.toRecoveryFile(v1)
    assert.deepEqual(JSON.parse(Buffer.from(ungzip(bytesOf(file.data))).toString()), levelData)
    assert.equal(file.name, 'coconut.nsld')
    assert.equal(gate.toRecoveryFile(v1Unnamed).name, 'Recovery.nsld')
    assert.equal(gate.toRecoveryFile(raw).name, 'Recovery.json')
    assert.equal(
        gate.toRecoveryFile(JSON.stringify({ ...JSON.parse(v1), filename: 'a/b.NSLD' })).name,
        'a_b.NSLD',
    )
})

// Journals as the bundle writes them: one ordinary, one written while storage was unavailable.
const journalOf = (
    sessionId: string,
    change: (journal: JournalV1) => void = () => undefined,
): JournalV1 => {
    const journal: JournalV1 = {
        journalVersion: JOURNAL_VERSION,
        kind: 'journal',
        recordsV: RECORDS_V,
        appVersion: '0.6.0',
        writtenAt: Date.UTC(2026, 9, 15, 14, 5),
        sessionId,
        seq: 812,
        descriptor: {
            v: SESSION_V,
            origin: 'continued',
            parent: { id: '9e41', uptoSeq: 790 },
            startedAt: 1_792_120_000_000,
            edited: true,
            hasContent: true,
            chainId: 'chain',
            docId: 'doc',
            lineageId: 'lineage',
            name: 'Coconut (Master)',
        },
        ...journalContent(stateOf(goldenChart())),
        stack: {
            keep: 8,
            lastKept: '0123456789abcdef0123456789abcdef',
            dropped: ['Moved notes'],
            head: { label: 'Changed BPM' },
            index: 8,
        },
    }
    change(journal)
    return journal
}
const ordinary = journalOf('s1')
const unavailable = journalOf('s2', (journal) => {
    journal.stack = { keep: 0, dropped: [], head: { label: 'Added note' }, index: 0 }
    delete journal.descriptor.name
    journal.descriptor.sourceName = 'coconut.nsld'
})

test('the gate offers a journal’s level data, which the bundle’s reader accepts', () => {
    for (const journal of [ordinary, unavailable]) {
        const text = JSON.stringify(journal)
        assert.equal(readJournal(text, journal.sessionId).kind, 'journal')
        const file = gate.journalFile(text)
        assert.ok(file)
        // The same bytes as the journal's own base64, and they decode to its level data.
        assert.deepEqual(bytesOf(file.data), Buffer.from(journal.levelDataGz, 'base64'))
        assert.deepEqual(
            JSON.parse(Buffer.from(ungzip(bytesOf(file.data))).toString()),
            journalLevelData(journal),
        )
        assert.equal(file.type, 'application/octet-stream')
        assert.equal(file.writtenAt, journal.writtenAt)
    }
    assert.equal(gate.journalFile(JSON.stringify(ordinary))?.name, 'Coconut (Master).nsld')
    assert.equal(gate.journalFile(JSON.stringify(unavailable))?.name, 'coconut.nsld.nsld')
    const unnamed = journalOf('s3', (journal) => {
        delete journal.descriptor.name
    })
    assert.equal(gate.journalFile(JSON.stringify(unnamed))?.name, 'Untitled.nsld')
})

test('the gate reads any journalVersion and skips what holds no level data', () => {
    const later = JSON.stringify({ ...ordinary, journalVersion: 9, kind: 'headCopy', extra: [1] })
    assert.equal(readJournal(later, 's1').kind, 'later')
    assert.deepEqual(
        bytesOf(gate.journalFile(later)?.data ?? ''),
        Buffer.from(ordinary.levelDataGz, 'base64'),
    )
    assert.equal(gate.journalFile('not json'), undefined)
    assert.equal(gate.journalFile('null'), undefined)
    assert.equal(gate.journalFile('3'), undefined)
    assert.equal(
        gate.journalFile(JSON.stringify({ ...ordinary, levelDataGz: undefined })),
        undefined,
    )
    assert.equal(gate.journalFile(JSON.stringify({ ...ordinary, levelDataGz: '' })), undefined)
    assert.equal(gate.journalFile(JSON.stringify({ ...ordinary, levelDataGz: 7 })), undefined)
    assert.equal(gate.journalFile(JSON.stringify({ ...ordinary, levelDataGz: '!!!' })), undefined)
})

const stored = (items: Record<string, string>) => {
    const storage = new MemoryStorage()
    for (const [key, value] of Object.entries(items)) storage.setItem(prefix + key, value)
    return storage
}

test('the gate lists the auto save, the unreadable one, the legacy slot and each journal', () => {
    const storage = stored({
        'autoSave.levelData': v1,
        'autoSave.unreadable': 'damaged',
        legacyRecovery: raw,
        'journal.s1': JSON.stringify(ordinary),
        'journal.s2': JSON.stringify(unavailable),
        'journal.s3': 'not json',
        settingsOnly: '1',
    })
    // A key under another prefix is not the editor’s.
    storage.setItem('other.journal.x', JSON.stringify(ordinary))
    const files = gate.recoveryFiles(storage)
    // Both journals were written at the same time, so the time tells them apart.
    const when = clock(ordinary.writtenAt)
    assert.deepEqual(
        files.map((file) => file.label),
        [
            'Download Your Last Auto Save',
            'Download Unreadable Auto Save',
            'Download Your Last Auto Save',
            `Download Unsaved Work from ${when}`,
            `Download Unsaved Work from ${when}`,
        ],
    )
    assert.deepEqual(
        files.map((file) => file.name),
        [
            'coconut.nsld',
            'Recovery.txt',
            'Recovery.json',
            'Coconut (Master).nsld',
            'coconut.nsld.nsld',
        ],
    )
})

test('the legacy slot is not offered twice beside the auto save it copies', () => {
    const files = gate.recoveryFiles(stored({ 'autoSave.levelData': v1, legacyRecovery: v1 }))
    assert.equal(files.length, 1)
    assert.equal(gate.recoveryFiles(stored({ legacyRecovery: v1Unnamed })).length, 1)
    assert.equal(gate.recoveryFiles(stored({})).length, 0)
})

test('journals are listed newest first, with the time only when a day repeats', () => {
    const at = (day: number, hour: number) => Date.UTC(2026, 9, day, hour, 30)
    const earlier = journalOf('a', (journal) => (journal.writtenAt = at(14, 9)))
    const sameDayEarly = journalOf('b', (journal) => (journal.writtenAt = at(16, 8)))
    const sameDayLate = journalOf('c', (journal) => (journal.writtenAt = at(16, 9)))
    const noTime = journalOf('d', (journal) => {
        delete (journal as Partial<JournalV1>).writtenAt
    })
    const files = gate.recoveryFiles(
        stored({
            'journal.a': JSON.stringify(earlier),
            'journal.b': JSON.stringify(sameDayEarly),
            'journal.c': JSON.stringify(sameDayLate),
            'journal.d': JSON.stringify(noTime),
        }),
    )
    const labels = [
        `Download Unsaved Work from ${clock(at(16, 9))}`,
        `Download Unsaved Work from ${clock(at(16, 8))}`,
        `Download Unsaved Work from ${day(at(14, 9))}`,
        'Download Unsaved Work from an earlier visit',
    ]
    // Two of the days can coincide in a far time zone; the order is what matters then.
    if (new Set([day(at(14, 9)), day(at(16, 8)), day(at(16, 9))]).size === 3)
        assert.deepEqual(
            files.map((file) => file.label),
            labels,
        )
})

// A window, document and storage with just what the page does.
type FakeElement = {
    tag: string
    style: Record<string, string>
    attributes: Record<string, string>
    children: FakeElement[]
    textContent?: string
    type?: string
    href?: string
    download?: string
    listeners: Record<string, () => void>
    appendChild: (child: FakeElement) => FakeElement
    removeChild: (child: FakeElement) => FakeElement
    setAttribute: (name: string, value: string) => void
    addEventListener: (type: string, listener: () => void) => void
    click: () => void
}

type FakeWindow = ReturnType<typeof fakeWindow>

const fakeWindow = (
    options: {
        userAgent?: string
        storage?: MemoryStorage | 'throws'
        secure?: boolean
        /** The page is still being parsed: its body isn't there until DOMContentLoaded. */
        loading?: boolean
    } = {},
) => {
    const clicks: { href: string; download: string }[] = []
    const blobs = new Map<string, Blob>()
    const revoked: string[] = []
    const timers: { delay: number; run: () => void }[] = []
    const element = (tag: string): FakeElement => {
        const self: FakeElement = {
            tag,
            style: {},
            attributes: {},
            children: [],
            listeners: {},
            appendChild: (child) => {
                self.children.push(child)
                return child
            },
            removeChild: (child) => {
                self.children.splice(self.children.indexOf(child), 1)
                return child
            },
            setAttribute: (name, value) => {
                self.attributes[name] = value
            },
            addEventListener: (type, listener) => {
                self.listeners[type] = listener
            },
            click: () => {
                clicks.push({ href: self.href ?? '', download: self.download ?? '' })
            },
        }
        return self
    }
    const documentElement = element('html')
    const parsed: (() => void)[] = []
    const document = {
        documentElement,
        readyState: options.loading ? 'loading' : 'complete',
        body: element('body'),
        createElement: element,
        addEventListener: (type: string, listener: () => void) => {
            if (type === 'DOMContentLoaded') parsed.push(listener)
        },
    }
    const win = {
        ...modern(),
        navigator: { ...modern().navigator, userAgent: options.userAgent ?? '' },
        ...(options.secure === undefined ? {} : { isSecureContext: options.secure }),
        document,
        get localStorage() {
            if (options.storage === 'throws') throw new DOMException('denied', 'SecurityError')
            return options.storage ?? new MemoryStorage()
        },
        Blob,
        URL: {
            createObjectURL: (blob: Blob) => {
                const url = `blob:fake/${blobs.size}`
                blobs.set(url, blob)
                return url
            },
            revokeObjectURL: (url: string) => revoked.push(url),
        },
        setTimeout: (run: () => void, delay: number) => timers.push({ run, delay }),
    }
    return Object.assign(win, {
        clicks,
        blobs,
        revoked,
        timers,
        documentElement,
        nseUnsupported: undefined as boolean | undefined,
        /** The parser reaches the end of the page. */
        finishParsing: () => {
            document.readyState = 'complete'
            for (const listener of parsed) listener()
        },
    })
}

// A page that lacks navigator.locks, as Safari 15 does.
const noLocks = (extra: Parameters<typeof fakeWindow>[0] = {}) => {
    const win = fakeWindow(extra)
    ;(win.navigator as { locks?: unknown }).locks = undefined
    return win
}

const buttonsOf = (win: ReturnType<typeof fakeWindow>) =>
    (win.document.body.children[0]?.children ?? []).filter((child) => child.tag === 'button')

test('a supported browser is left alone: no storage read, no page change', () => {
    const win = fakeWindow()
    Object.defineProperty(win, 'localStorage', {
        get: () => {
            throw new Error('storage was read')
        },
    })
    assert.equal(gate.run(win), false)
    assert.equal(win.nseUnsupported, undefined)
    assert.equal(win.document.body.children.length, 0)
    assert.equal(win.documentElement.attributes['data-gate'], undefined)
})

test('an insecure context skips the check', () => {
    const win = noLocks({ secure: false })
    assert.equal(gate.run(win), false)
    assert.equal(win.nseUnsupported, undefined)
    assert.equal(gate.run(noLocks({ secure: true })), true)
})

test('an unsupported browser flags the bundle to stop and says why', () => {
    const win = noLocks({ userAgent: uas.windowsChrome })
    assert.equal(gate.run(win), true)
    assert.equal(win.nseUnsupported, true)
    assert.equal(win.documentElement.attributes['data-gate'], 'unsupported')
    const main = win.document.body.children[0]
    assert.equal(main?.tag, 'main')
    assert.equal(main?.children[0]?.textContent, 'This browser is too old for the editor.')
    assert.equal(buttonsOf(win).length, 0)
    const iphone = noLocks({ userAgent: uas.iphoneSafari })
    gate.run(iphone)
    assert.equal(
        iphone.document.body.children[0]?.children[0]?.textContent,
        'This editor needs Safari 17 or later.',
    )
})

test('the page goes in once the body is parsed, the flag at once', () => {
    const win = noLocks({ loading: true })
    assert.equal(gate.run(win), true)
    assert.equal(win.nseUnsupported, true)
    assert.equal(win.document.body.children.length, 0)
    win.finishParsing()
    assert.equal(win.document.body.children[0]?.tag, 'main')
    assert.equal(win.documentElement.attributes['data-gate'], 'unsupported')
})

test('unavailable storage still shows the message', () => {
    const win = noLocks({ storage: 'throws' })
    assert.equal(gate.run(win), true)
    assert.equal(buttonsOf(win).length, 0)
    assert.equal(
        win.document.body.children[0]?.children[0]?.textContent,
        'This browser is too old for the editor.',
    )
})

test('a button downloads its file, the same bytes as the stored work', async () => {
    const storage = stored({
        legacyRecovery: v1,
        'journal.s1': JSON.stringify(ordinary),
        'autoSave.unreadable': 'damaged text',
    })
    const win = noLocks({ storage })
    gate.run(win)
    const buttons = buttonsOf(win)
    assert.deepEqual(
        buttons.map((button) => button.textContent),
        [
            'Download Unreadable Auto Save',
            'Download Your Last Auto Save',
            `Download Unsaved Work from ${day(ordinary.writtenAt)}`,
        ],
    )
    assert.ok(buttons.every((button) => button.type === 'button'))
    const downloads: { name: string; bytes: Buffer }[] = []
    for (const button of buttons) {
        button.listeners.click?.()
        const click = win.clicks.at(-1)
        assert.ok(click)
        const blob = win.blobs.get(click.href)
        assert.ok(blob)
        downloads.push({ name: click.download, bytes: Buffer.from(await blob.arrayBuffer()) })
    }
    assert.deepEqual(
        downloads.map((download) => download.name),
        ['Recovery.txt', 'coconut.nsld', 'Coconut (Master).nsld'],
    )
    assert.equal(downloads[0]?.bytes.toString(), 'damaged text')
    assert.deepEqual(downloads[1]?.bytes, Buffer.from(JSON.parse(v1).levelData as string, 'base64'))
    assert.deepEqual(downloads[2]?.bytes, Buffer.from(ordinary.levelDataGz, 'base64'))
    // The links are removed again, and the object URLs freed later.
    assert.equal(win.document.body.children.filter((child) => child.tag === 'a').length, 0)
    assert.equal(win.revoked.length, 0)
    for (const timer of win.timers) timer.run()
    assert.equal(win.revoked.length, 3)
})
