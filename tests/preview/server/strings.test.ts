import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

// The strings of From a Server (Part 2, 2.6, 2.11).

const locales = readdirSync('src/i18n', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
const raw = (locale: string) => readFileSync(`src/i18n/${locale}/index.json`, 'utf8')

test('no locale file names Coconut, the server the Default came from', () => {
    for (const locale of locales) assert.doesNotMatch(raw(locale), /coconut/i, locale)
})

type Strings = Record<string, unknown>
const previewAssets = (locale: string) =>
    (JSON.parse(raw(locale)) as { commands: { previewAssets: Strings } }).commands.previewAssets

test('every locale has the From a Server strings', () => {
    const keys = [
        'chooseHint',
        'fromFile',
        'fromServer',
        'serverAddress',
        'connect',
        'search',
        'more',
        'alsoServerItem',
        'noneFound',
    ]
    const nested = ['progress.connecting', 'progress.downloading']
    const server = [
        'unreachable',
        'auth',
        'insecure',
        'checksum',
        'notFound',
        'invalid',
        'status',
        'filesFailed',
        'addressEmpty',
        'addressInvalid',
        'addressCredentials',
    ]
    for (const locale of locales) {
        const strings = previewAssets(locale)
        for (const key of keys) assert.equal(typeof strings[key], 'string', `${locale} ${key}`)
        for (const path of nested) {
            const [group, key] = path.split('.') as [string, string]
            assert.equal(typeof (strings[group] as Strings)[key], 'string', `${locale} ${path}`)
        }
        for (const key of server)
            assert.equal(
                typeof (strings.server as Strings)[key],
                'string',
                `${locale} server.${key}`,
            )
        assert.equal(typeof (strings.serverImport as Strings).ratio, 'string', `${locale} ratio`)
    }
})

test('the web-only strings are gone from every locale', () => {
    for (const locale of locales) {
        const strings = previewAssets(locale)
        assert.equal(strings.forServerOwners, undefined, locale)
        for (const key of ['blocked', 'blockedRoute', 'blockedOwners'])
            assert.equal((strings.server as Strings)[key], undefined, `${locale} server.${key}`)
        const help = (JSON.parse(raw(locale)) as { help: Strings }).help
        assert.equal(help.builtinServer, undefined, locale)
    }
})

test('the English words follow the editor’s conventions', () => {
    const english = previewAssets('en')
    const values = (value: unknown): string[] =>
        typeof value === 'string'
            ? [value]
            : Object.values(value as Strings).flatMap((inner) => values(inner))
    for (const text of [
        ...values(english.server),
        ...values(english.serverImport),
        english.chooseHint,
        english.alsoServerItem,
        english.noneFound,
    ] as string[]) {
        // ’ for apostrophes, and no contractions.
        assert.doesNotMatch(text, /'/, text)
        assert.doesNotMatch(text, /\b\w+n’t\b|’(?:re|ll|ve|d)\b/, text)
    }
    // Buttons are in Title Case.
    assert.equal(english.connect, 'Connect')
    assert.equal(english.fromServer, 'From a Server')
})
