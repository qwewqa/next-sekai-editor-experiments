import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

// The web's /privacy/ page: its source, before the build fills the placeholders.
const html = readFileSync(new URL('../../privacy/index.html', import.meta.url), 'utf8')
const require = createRequire(import.meta.url)
const text = html
    .replace(/<script\b[\s\S]*?<\/script>/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')

const attributes = (name) =>
    [...html.matchAll(new RegExp(`\\b${name}="([^"]*)"`, 'g'))].map(([, value]) => value)

test('the page has one h1 and the landmarks', () => {
    assert.equal(html.match(/<h1\b/g)?.length, 1)
    for (const tag of ['header', 'main', 'footer'])
        assert.equal(html.match(new RegExp(`<${tag}\\b`, 'g'))?.length, 1, tag)
    assert.match(html, /<html lang="en">/)
})

test('the contact address is nse@qwewqa.dev, the only one', () => {
    assert.deepEqual(
        [...new Set(attributes('href').filter((href) => href.startsWith('mailto:')))],
        ['mailto:nse@qwewqa.dev'],
    )
    assert.deepEqual([...new Set(text.match(/[\w.-]+@[\w.-]+/g))], ['nse@qwewqa.dev'])
})

test('every link is on the site or on the allow-list', () => {
    const allowed = [
        /^https:\/\/github\.com\/%GITHUB_REPOSITORY%(?:\/issues|\/blob\/main\/CHANGELOG\.md)?$/,
        /^https:\/\/github\.com\/%GITHUB_REPOSITORY%\/blob\/main\/docs\/usage-statistics\.md$/,
        /^https:\/\/docs\.github\.com\/en\/site-policy\/privacy-policies\/github-general-privacy-statement$/,
        /^mailto:nse@qwewqa\.dev$/,
        /^https:\/\/nse\.qwewqa\.dev\/privacy\/$/,
        /^\/(?:LICENSE\.txt|THIRD_PARTY_NOTICES\.txt)?$/,
        /^\/builtin-assets\/out\/icon\/app-icon-(?:32|180)\.png$/,
        /^\/src\/landing\/landing\.css$/,
    ]
    for (const url of [...attributes('href'), ...attributes('src')])
        assert.ok(
            allowed.some((pattern) => pattern.test(url)),
            url,
        )
})

test("the icon is the app icon, and never the editor's favicon or thumbnail", () => {
    assert.match(html, /<link rel="icon"[^>]*app-icon-32\.png/)
    assert.match(html, /<link rel="apple-touch-icon"[^>]*app-icon-180\.png/)
    assert.doesNotMatch(html, /thumbnail\.png|favicon\.ico/)
})

test("the page loads no script and has the theme script's placeholders", () => {
    assert.doesNotMatch(html, /<script\b[^>]*\bsrc=/)
    assert.equal(html.match(/<script\b/g)?.length, 1)
    assert.equal(html.match(/THEMES\.includes/g)?.length, 1)
    assert.equal(html.match(/getItem\(THEME_KEY\)/g)?.length, 1)
})

test('the page allows zoom', () => {
    const viewport = attributes('content').find((value) => value.includes('width=device-width'))
    assert.equal(viewport, 'width=device-width, initial-scale=1.0')
})

test('the date is valid and its text matches', () => {
    const [, iso, shown] = /<time datetime="([^"]+)">([^<]+)<\/time>/.exec(html) ?? []
    assert.match(iso, /^\d{4}-\d{2}-\d{2}$/)
    const date = new Date(`${iso}T00:00:00Z`)
    assert.equal(
        date.toLocaleDateString('en-US', {
            timeZone: 'UTC',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        }),
        shown,
    )
})

test('the page is titled Privacy Notice', () => {
    assert.match(html, /<title>Privacy Notice – %PRODUCT_NAME%<\/title>/)
    assert.match(html, /<h1\b[^>]*>\s*Privacy Notice\s*<\/h1>/)
})

test("the wording follows the editor's conventions", () => {
    assert.doesNotMatch(text, /\w'\w/, 'a straight apostrophe')
    assert.doesNotMatch(
        text,
        /\b(?:don’t|doesn’t|isn’t|aren’t|won’t|can’t|couldn’t|shouldn’t|wouldn’t|didn’t|hasn’t|haven’t|it’s|that’s|we’re|you’re|we’ve|you’ve|we’ll|you’ll)\b/i,
    )
    assert.doesNotMatch(text, /!/)
    const small = new Set(['a', 'and', 'from', 'of', 'the', 'to', 'in'])
    for (const [, heading] of html.matchAll(/<h[23]\b[^>]*>\s*([^<]+?)\s*<\/h[23]>/g))
        for (const word of heading.split(' ').filter((word) => !small.has(word)))
            assert.match(word, /^[A-Z]/, `${heading}: ${word}`)
})

test('the web page does not describe the apps', () => {
    assert.doesNotMatch(text, /\b(?:apps?|Windows|macOS|Android|iPhone|iPad|SignPath)\b/)
})

test('the placeholders are the ones the build fills', () => {
    const names = new Set(html.match(/%[A-Z_]+%/g))
    assert.deepEqual([...names].sort(), ['%GITHUB_REPOSITORY%', '%PRODUCT_NAME%'])
})

test("the landing config shares the editor's colours and shadows, and reads the page", () => {
    const shared = require('../../tailwind.colors.js')
    const editor = require('../../tailwind.config.js')
    const landing = require('../../tailwind.landing.config.js')
    assert.deepEqual(editor.theme.extend.colors, shared.colors)
    assert.deepEqual(landing.theme.extend.colors, shared.colors)
    assert.deepEqual(editor.theme.extend.boxShadow, shared.boxShadow)
    assert.deepEqual(landing.theme.extend.boxShadow, shared.boxShadow)
    assert.ok(landing.content.files.includes('./privacy/index.html'))
    assert.ok(
        !editor.content.files.some((glob) => glob.includes('privacy') || glob.includes('landing')),
    )
})
