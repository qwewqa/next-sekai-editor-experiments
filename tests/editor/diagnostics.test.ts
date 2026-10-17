import assert from 'node:assert/strict'
import test from 'node:test'
import { RING_SIZE, formatDiagnostics, redactPaths, type RingEntry } from '../../src/diagnostics'

const fields = (entries: RingEntry[]) => ({
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
