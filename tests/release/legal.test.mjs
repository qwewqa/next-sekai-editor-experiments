import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { legalPages, pageRevision } from '../../scripts/legal.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const dated = (revision) =>
    `<p>Last updated: <time datetime="2026-10-27" data-revision="${revision}">October 27, 2026</time></p>`

const checkout = async (t, pages) => {
    const directory = await mkdtemp(join(tmpdir(), 'sekai-legal-test-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    for (const [name, html] of Object.entries(pages)) {
        await mkdir(join(directory, name), { recursive: true })
        await writeFile(join(directory, name, 'index.html'), html)
    }
    return directory
}

test("the checkout's pages state their revisions, and the apps' build has none", () => {
    const revisions = legalPages(root, 'production')
    assert.deepEqual(Object.keys(revisions).sort(), ['privacy', 'terms'])
    for (const revision of Object.values(revisions)) assert.ok(Number.isInteger(revision))
    assert.deepEqual(legalPages(root, 'native'), {})
})

test('each page that exists gives its revision', async (t) => {
    const directory = await checkout(t, { privacy: dated(2), terms: dated(1) })
    assert.deepEqual(legalPages(directory, 'production'), { privacy: 2, terms: 1 })
    assert.deepEqual(legalPages(directory, 'native'), {})
    const privacyOnly = await checkout(t, { privacy: dated(3) })
    assert.deepEqual(legalPages(privacyOnly, 'production'), { privacy: 3 })
})

test('a page without one whole revision of 1 or more fails the build, naming the file', async (t) => {
    for (const html of [
        '<time datetime="2026-10-27">October 27, 2026</time>',
        dated(0),
        dated(-1),
        dated(1.5),
        dated('one'),
        dated(''),
        dated(1) + dated(2),
    ]) {
        assert.throws(() => pageRevision(html, 'terms/index.html'), /terms\/index\.html/, html)
        const directory = await checkout(t, { privacy: dated(1), terms: html })
        assert.throws(() => legalPages(directory, 'production'), /terms\/index\.html/, html)
    }
    assert.equal(pageRevision(dated(12), 'privacy/index.html'), 12)
})
