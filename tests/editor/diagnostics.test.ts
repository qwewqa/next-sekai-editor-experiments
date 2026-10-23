import assert from 'node:assert/strict'
import test from 'node:test'
import {
    RING_SIZE,
    formatDiagnostics,
    messageOf,
    recordDiagnostic,
    redactPaths,
    resetRingForTests,
    ringEntries,
    type DiagnosticFields,
    type RingEntry,
} from '../../src/diagnostics'

const fields = (entries: RingEntry[]): DiagnosticFields => ({
    productName: 'Next SEKAI Editor',
    appVersion: '0.6.0',
    atTag: true,
    hasCommit: false,
    site: 'production',
    engine: 'chromium',
    os: 'windows',
    standalone: false,
    userAgent: 'UA',
    estimate: { usage: 1500, quota: 1073741824 },
    entries,
})

test('the home folder in a path becomes ~', () => {
    assert.equal(
        redactPaths(String.raw`at C:\Users\kyle\work\a.nxsp:1`),
        String.raw`at ~\work\a.nxsp:1`,
    )
    assert.equal(redactPaths('/Users/kyle/Library/a'), '~/Library/a')
    assert.equal(redactPaths('open /home/kyle/a.nxsp failed'), 'open ~/a.nxsp failed')
    assert.equal(redactPaths('https://x.dev/home/page'), 'https://x.dev/home/page')
})

test('the text names the version, engine, OS, standalone, storage and the ring', () => {
    const text = formatDiagnostics(
        fields([
            {
                at: 0,
                kind: 'csp',
                text: String.raw`script-src blocked inline at C:\Users\kyle\a.js:3`,
            },
        ]),
    )
    assert.match(text, /^Next SEKAI Editor 0\.6\.0$/m)
    assert.match(text, /^Engine: chromium$/m)
    assert.match(text, /^OS: windows$/m)
    assert.match(text, /^Standalone: no$/m)
    assert.match(text, /^Storage: 1\.5 KB used of about 1[.]1 GB$/m)
    assert.match(
        text,
        /^- 1970-01-01T00:00:00\.000Z csp: script-src blocked inline at ~\\a\.js:3$/m,
    )
    assert.doesNotMatch(text, /kyle/)
})

test('a missing storage value is not printed as a value', () => {
    const text = (estimate: { usage?: number; quota?: number }) =>
        formatDiagnostics({ ...fields([]), estimate })
    assert.match(text({ usage: 2_000_000 }), /^Storage: 2\.0 MB used, quota unknown$/m)
    assert.match(
        text({ quota: 1_000_000_000 }),
        /^Storage: about 1\.0 GB available, usage unknown$/m,
    )
    assert.match(text({ usage: 999 }), /^Storage: 999 B used, quota unknown$/m)
})

test('the build line agrees with About: release, between releases, or untagged', () => {
    const build = (atTag: boolean, hasCommit: boolean) =>
        formatDiagnostics({ ...fields([]), atTag, hasCommit }).match(/^Build: (.*)$/m)?.[1]
    assert.equal(build(true, false), 'release')
    assert.equal(build(false, true), 'between releases')
    assert.equal(build(false, false), 'untagged')
})

test('without a storage estimate or entries the text says so', () => {
    const text = formatDiagnostics({ ...fields([]), estimate: undefined })
    assert.match(text, /^Storage: unavailable$/m)
    assert.match(text, new RegExp(`Last ${RING_SIZE} errors and CSP violations: none`))
})

test('without storage facts the text leaves the storage lines out', () => {
    const text = formatDiagnostics(fields([]))
    assert.doesNotMatch(text, /^(Database|Storing|Worker restarts|Sessions):/m)
})

test('the text names the database, whether storing is paused and why, restarts and counts', () => {
    const text = (storing: NonNullable<DiagnosticFields['storing']>) =>
        formatDiagnostics({ ...fields([]), storing })
    const on = text({
        mode: 'stored',
        restarts: 0,
        database: { version: 2, format: 1, sessions: 12, chains: 5 },
    })
    assert.match(on, /^Database: version 2, format 1$/m)
    assert.match(on, /^Storing: on$/m)
    assert.match(on, /^Worker restarts: 0$/m)
    assert.match(on, /^Sessions: 12, chains: 5$/m)
    const full = text({ mode: 'stored', reason: 'full', restarts: 3 })
    assert.match(full, /^Storing: paused \(full\)$/m)
    assert.match(full, /^Worker restarts: 3$/m)
    assert.match(text({ mode: 'readOnly', restarts: 0 }), /^Storing: read-only$/m)
    assert.match(text({ mode: 'memory', restarts: 1 }), /^Storing: off, in memory only$/m)
    assert.match(
        text({ mode: 'memory', reason: 'olderTabs', restarts: 1 }),
        /^Storing: off, in memory only \(olderTabs\)$/m,
    )
    const unknown = text({ restarts: 0 })
    assert.match(unknown, /^Storing: not started$/m)
    assert.match(unknown, /^Database: unavailable$/m)
    assert.match(unknown, /^Sessions: unavailable$/m)
})

test('the same error twice in a row is recorded once, so a retry loop leaves room for the rest', () => {
    resetRingForTests()
    const before = ringEntries().length
    recordDiagnostic('error', 'A flush failed: quota', 1000)
    recordDiagnostic('error', 'A flush failed: quota', 2000)
    recordDiagnostic('csp', 'A flush failed: quota', 3000)
    recordDiagnostic('error', 'Another', 4000)
    recordDiagnostic('error', 'A flush failed: quota', 5000)
    assert.equal(ringEntries().length, before + 4)
    resetRingForTests()
})

test('the CSP violation listener writes to the diagnostics ring and calls the test hook', async () => {
    const listeners: ((event: unknown) => void)[] = []
    const hooked: unknown[] = []
    Object.assign(globalThis, {
        document: {
            addEventListener: (_: string, listener: (event: unknown) => void) =>
                listeners.push(listener),
        },
        window: { nseCspViolationHook: (violation: unknown) => hooked.push(violation) },
    })
    const { ringEntries } = await import('../../src/diagnostics')
    await import('../../src/csp')
    assert.equal(listeners.length, 1)
    const quiet = console.error
    console.error = () => undefined
    try {
        listeners[0]!({
            effectiveDirective: 'script-src',
            blockedURI: 'inline',
            sample: '',
            sourceFile: '',
            lineNumber: 0,
        })
    } finally {
        console.error = quiet
    }
    assert.equal(hooked.length, 1)
    assert.deepEqual(
        ringEntries().map(({ kind, text }) => ({ kind, text })),
        [{ kind: 'csp', text: 'script-src blocked inline' }],
    )
})

test('an error keeps its message when the stack leaves it out', () => {
    // Firefox and Safari: the stack is only the frames.
    const bare = new Error('storing is paused')
    bare.stack = 'launch@http://x/client.ts:1:2\nstart@http://x/client.ts:3:4'
    assert.equal(
        messageOf(bare),
        'Error: storing is paused\nlaunch@http://x/client.ts:1:2\nstart@http://x/client.ts:3:4',
    )
    // Chromium: the stack starts with the message.
    const full = new Error('storing is paused')
    full.stack = 'Error: storing is paused\n    at a (x:1:2)'
    assert.equal(messageOf(full), 'Error: storing is paused\n    at a (x:1:2)')
    assert.equal(messageOf('plain'), 'plain')
})

test('the text says whether the browser keeps the data, and that it is unknown when it cannot say', () => {
    const line = (persisted: boolean | undefined) =>
        formatDiagnostics({
            ...fields([]),
            ...(persisted === undefined ? {} : { persisted }),
        }).match(/^Persistent storage: (.*)$/m)?.[1]
    assert.equal(line(true), 'yes')
    assert.equal(line(false), 'no')
    assert.equal(line(undefined), 'unknown')
})
