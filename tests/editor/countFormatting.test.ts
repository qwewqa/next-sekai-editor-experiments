import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

const source = new URL('../../src/', import.meta.url)
const files: { path: string; text: string }[] = []
const walk = (directory: URL) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory)
        if (entry.isDirectory()) walk(child)
        else if (/\.(ts|vue)$/.test(entry.name))
            files.push({
                path: child.href.slice(source.href.length),
                text: readFileSync(child, 'utf8'),
            })
    }
}
walk(source)

const matches = (pattern: RegExp) =>
    files.flatMap(({ path, text }) =>
        text
            .split('\n')
            .flatMap((line, index) => (pattern.test(line) ? [`${path}:${index + 1}`] : [])),
    )

// A count shown to the user goes through formatCount (utils/size.ts), which groups digits as the
// interface language does ("1,234" and "1 234"); a bare template literal or String() does not.
test('no user-facing count is written as a bare template literal or String()', () => {
    const bareTemplate =
        /`\$\{[^{}`]*(\.length|\.size|[cC]ount(\.value)?|\.total|\.covered|\.shown|\bshown|\btotal)\}`/
    const bareString = /String\((\w+\.)*\w*([cC]ount|total|covered|shown)\)(?!\.length)/
    assert.deepEqual(matches(bareTemplate), [])
    assert.deepEqual(matches(bareString), [])
})

// One shared helper owns the grouping, so a locale rule is changed in one place.
test('number formatting for display lives in utils/size and the property formatter', () => {
    const formatters = matches(/new Intl\.NumberFormat\(/)
        .map((place) => place.replace(/:\d+$/, ''))
        .filter((path, index, all) => all.indexOf(path) === index)
        .sort()
    assert.deepEqual(formatters, [
        'editor/history/propertyPresentation.ts',
        'utils/formatPropertyNumber.ts',
        'utils/size.ts',
    ])
})

// A sentence of two localized parts is joined with the locale's own join, never a literal ". ".
test('two localized sentences are never joined with a literal ". "', () => {
    assert.deepEqual(matches(/`\$\{[^{}`]+\}\. \$\{/), [])
})
