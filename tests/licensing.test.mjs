import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/** The annotations of REUSE.toml: tables of strings and lists of strings, which is all it uses. */
export function parseReuse(text) {
    const annotations = []
    let current
    let list
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        if (list) {
            if (line === ']') list = undefined
            else list.push(line.match(/^"([^"]*)",?$/)[1])
            continue
        }
        if (line === '[[annotations]]') {
            current = {}
            annotations.push(current)
            continue
        }
        const [, key, value] = line.match(/^([A-Za-z-]+) = (.*)$/)
        if (value === '[') {
            list = []
            if (current) current[key] = list
        } else if (current) current[key] = value.match(/^"(.*)"$/)[1]
    }
    return annotations
}

const globToRegExp = (glob) =>
    new RegExp(
        '^' +
            glob
                .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                .replace(/\*\*\//g, '@DIRS@')
                .replace(/\*\*/g, '@ANY@')
                .replace(/\*/g, '[^/]*')
                .replace(/@DIRS@/g, '(?:.*/)?')
                .replace(/@ANY@/g, '.*') +
            '$',
    )

/** The annotation that covers a path (the last that matches), and whether it is more than the default. */
export function annotationFor(annotations, path) {
    let found
    for (const annotation of annotations) {
        const paths = [annotation.path].flat()
        if (paths.some((glob) => globToRegExp(glob).test(path))) found = annotation
    }
    return found && { annotation: found, explicit: ![found.path].flat().includes('**') }
}

const annotations = parseReuse(readFileSync(new URL('../REUSE.toml', import.meta.url), 'utf8'))
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)

const media = /\.(?:png|ico|mp3|wav|scp|wasm|jpe?g|gif|webp|woff2?|ttf)$/i
const isMedia = (file) => media.test(file) || /(?:^|\/)badges\/.*\.svg$/.test(file)

test('REUSE.toml parses and its default annotation is MIT', () => {
    assert.ok(annotations.length > 5)
    assert.equal(annotations[0].path, '**')
    assert.equal(annotations[0]['SPDX-License-Identifier'], 'MIT')
    for (const annotation of annotations) {
        assert.ok(annotation.path)
        assert.ok(annotation['SPDX-License-Identifier'])
    }
})

test('every tracked binary or media file has an explicit REUSE.toml annotation', () => {
    const files = tracked.filter(isMedia)
    assert.ok(files.length > 10, 'the media files are found')
    const missing = files.filter((file) => !annotationFor(annotations, file)?.explicit)
    assert.deepEqual(missing, [])
})

test('the Built-in files and the icon renders are CC0', () => {
    const built = tracked.filter(
        (file) =>
            /^(?:public\/builtin|builtin-assets\/(?:svg|out))\//.test(file) ||
            /^builtin-assets\/.*\.lock\.json$/.test(file),
    )
    assert.ok(built.length > 0)
    for (const file of built)
        assert.equal(
            annotationFor(annotations, file)?.annotation['SPDX-License-Identifier'],
            'CC0-1.0',
            file,
        )
})

test('every tracked file containing "Font Awesome" is on the CC-BY-4.0 icon list', () => {
    // Files that mention the name without being icon artwork.
    const mentions =
        /^(?:REUSE\.toml|README\.md|CONTRIBUTING\.md|deployment\/|docs\/|scripts\/|tests\/)/
    const icons = tracked.filter((file) => {
        if (isMedia(file) || mentions.test(file)) return false
        return readFileSync(new URL(file, new URL('../', import.meta.url)), 'utf8').includes(
            'Font Awesome',
        )
    })
    assert.ok(icons.length > 50, 'the icon components are found')
    const unlisted = icons.filter(
        (file) =>
            annotationFor(annotations, file)?.annotation['SPDX-License-Identifier'] !== 'CC-BY-4.0',
    )
    assert.deepEqual(unlisted, [])
})

test('the upstream-unconfirmed files are not covered by MIT', () => {
    for (const file of ['src/preview/bg.png', 'public/favicon.ico', 'public/thumbnail.png'])
        assert.equal(
            annotationFor(annotations, file)?.annotation['SPDX-License-Identifier'],
            'LicenseRef-Upstream-Unconfirmed',
        )
})
