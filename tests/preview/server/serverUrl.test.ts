import assert from 'node:assert/strict'
import test from 'node:test'
import {
    displayOrigin,
    itemDetailsUrl,
    parseServerUrl,
    ServerUrlError,
    type ServerCategory,
} from '../../../src/preview/assets/serverUrl'

// What the From a Server field accepts (Part 2, 2.5.3, 2.11).

const failsWith = (input: string, code: string, options?: { allowHttp?: boolean }) =>
    assert.throws(
        () => parseServerUrl(input, options),
        (error) => error instanceof ServerUrlError && error.code === code,
        input,
    )

test('a server address is the base, without a trailing slash, a query or a hash', () => {
    assert.deepEqual(parseServerUrl('https://example.com/server'), {
        base: 'https://example.com/server',
    })
    assert.deepEqual(parseServerUrl('  https://example.com/server/  '), {
        base: 'https://example.com/server',
    })
    assert.deepEqual(parseServerUrl('https://example.com/?x=1#top'), {
        base: 'https://example.com',
    })
    assert.deepEqual(parseServerUrl('https://example.com:8443/a/b'), {
        base: 'https://example.com:8443/a/b',
    })
})

test('the address of the server’s own endpoints names the server', () => {
    assert.equal(
        parseServerUrl('https://example.com/server/sonolus').base,
        'https://example.com/server',
    )
    assert.equal(
        parseServerUrl('https://example.com/server/sonolus/info').base,
        'https://example.com/server',
    )
    assert.deepEqual(parseServerUrl('https://example.com/sonolus/skins/list'), {
        base: 'https://example.com',
    })
    assert.deepEqual(parseServerUrl('https://example.com/sonolus/effects/info'), {
        base: 'https://example.com',
    })
})

test('a bare host counts as https', () => {
    assert.deepEqual(parseServerUrl('example.com/server'), { base: 'https://example.com/server' })
    assert.deepEqual(parseServerUrl('localhost:3000'), { base: 'https://localhost:3000' })
})

test('a share link names the item and the server, for each of the four types', () => {
    const types: [string, ServerCategory][] = [
        ['skins', 'skins'],
        ['particles', 'particles'],
        ['backgrounds', 'backgrounds'],
        ['effects', 'effects'],
    ]
    for (const [path, category] of types) {
        assert.deepEqual(parseServerUrl(`https://example.com/server/${path}/neon`), {
            base: 'https://example.com/server',
            item: { category, name: 'neon' },
        })
        // The API form, a query and a trailing slash name the same item.
        assert.deepEqual(
            parseServerUrl(`https://example.com/server/sonolus/${path}/neon/?localization=en`),
            { base: 'https://example.com/server', item: { category, name: 'neon' } },
        )
    }
    assert.deepEqual(parseServerUrl('https://example.com/skins/neon%20night'), {
        base: 'https://example.com',
        item: { category: 'skins', name: 'neon night' },
    })
})

test('a sonolus:// deep link is rewritten to https', () => {
    assert.deepEqual(parseServerUrl('sonolus://example.com/server'), {
        base: 'https://example.com/server',
    })
    assert.deepEqual(parseServerUrl('sonolus://example.com/server/particles/spark'), {
        base: 'https://example.com/server',
        item: { category: 'particles', name: 'spark' },
    })
    assert.deepEqual(parseServerUrl('SONOLUS://example.com'), { base: 'https://example.com' })
})

test('an http address is refused on the web and taken where it is allowed', () => {
    failsWith('http://example.com/server', 'insecure')
    failsWith('http://localhost:3000/skins/neon', 'insecure')
    assert.deepEqual(parseServerUrl('http://localhost:3000', { allowHttp: true }), {
        base: 'http://localhost:3000',
    })
})

test('an empty field, other schemes, credentials and a broken address are refused', () => {
    failsWith('', 'empty')
    failsWith('   ', 'empty')
    failsWith('file:///skins/test', 'invalid')
    failsWith('javascript:alert(1)', 'invalid')
    failsWith('ftp://example.com', 'invalid')
    failsWith('https://', 'invalid')
    failsWith('https://user:secret@example.com/server', 'credentials')
    failsWith('https://example.com/skins/%E0%A4%A', 'invalid')
})

test('the release script’s item links resolve as before', () => {
    const expected = 'https://example.com/server/sonolus/skins/test?localization=en'
    assert.equal(
        itemDetailsUrl('https://example.com/server/skins/test?localization=en', 'skins'),
        expected,
    )
    assert.equal(itemDetailsUrl(expected, 'skins'), expected)
    assert.throws(() => itemDetailsUrl('https://example.com/particles/test', 'skins'), /Expected/)
    assert.throws(() => itemDetailsUrl('file:///skins/test', 'skins'), /HTTP/)
    assert.equal(
        itemDetailsUrl('http://localhost:3000/particles/spark', 'particles'),
        'http://localhost:3000/sonolus/particles/spark',
    )
})

test('addresses show without their scheme', () => {
    assert.equal(
        displayOrigin('https://nse.qwewqa.dev/builtin-server'),
        'nse.qwewqa.dev/builtin-server',
    )
    assert.equal(displayOrigin('neon.scp'), 'neon.scp')
})
