import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { isExistingUser, isUpdate, releaseOf } from '../../src/launch'
import { INTERNAL_KEYS, WEB_MIGRATION_FLAGS } from '../../src/settings/migrationFlags'

const prefix = 'sonolus-next-sekai-editor.'
const stored = (...keys: string[]) => keys.map((key) => prefix + key)

test('a profile with only a migration flag is a new user', () => {
    assert.equal(isExistingUser(stored('toolbarEditorLayoutMigrated'), prefix), false)
    assert.equal(isExistingUser([], prefix), false)
    assert.equal(
        isExistingUser(stored('toolbarEditorLayoutMigrated', 'diagnostics'), prefix),
        false,
    )
})

test('the first-visit mark alone is not an existing user', () => {
    assert.equal(isExistingUser(stored('firstVisitShown'), prefix), false)
})

test('the agreement record alone is not an existing user', () => {
    assert.equal(isExistingUser(stored('agreement'), prefix), false)
})

test('a stored lastAppVersion makes an existing user', () => {
    assert.equal(isExistingUser(stored('lastAppVersion'), prefix), true)
})

test('an old auto save makes an existing user', () => {
    assert.equal(isExistingUser(stored('autoSave.levelData'), prefix), true)
    assert.equal(isExistingUser(stored('autoSave.unreadable'), prefix), true)
})

test('a stored setting makes an existing user, and keys of other apps do not', () => {
    assert.equal(isExistingUser(stored('showPreview', 'toolbarEditorLayoutMigrated'), prefix), true)
    assert.equal(isExistingUser(['other.showPreview', 'nse.test.version'], prefix), false)
})

test('the version line: an update shows for an existing user, a changed release, and not for builds between tags', () => {
    // Existing user's first load of this update: no lastAppVersion yet.
    assert.equal(isUpdate(undefined, '0.6.0', true), true)
    // A true first visit.
    assert.equal(isUpdate(undefined, '0.6.0', false), false)
    assert.equal(isUpdate('0.5.22', '0.6.0', true), true)
    assert.equal(isUpdate('0.6.0', '0.6.0', true), false)
    // Only the X.Y.Z part counts.
    assert.equal(isUpdate('0.6.0', '0.6.0+abcd1234', true), false)
    assert.equal(isUpdate('0.6.0+abcd1234', '0.6.0', true), false)
    assert.equal(releaseOf('0.6.0+abcd1234'), '0.6.0')
})

// Every key a source file marks as a migration flag is in the one list.
const sources = (directory: string): string[] =>
    readdirSync(directory).flatMap((name) => {
        const path = join(directory, name)
        if (statSync(path).isDirectory()) return sources(path)
        return /\.(ts|vue)$/.test(name) ? [path] : []
    })

test('every migration flag key in the source is listed', () => {
    const found = new Set<string>()
    for (const file of sources(
        new URL('../../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    ))
        for (const match of readFileSync(file, 'utf8').matchAll(/'(\w+Migrated)'/g))
            found.add(match[1]!)
    assert.ok(found.size > 0)
    for (const key of found) assert.ok(WEB_MIGRATION_FLAGS.includes(key), key)
    for (const key of INTERNAL_KEYS) assert.ok(!WEB_MIGRATION_FLAGS.includes(key), key)
})
