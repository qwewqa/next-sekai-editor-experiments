import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { appVersion, isHighestTag } from '../../scripts/version.mjs'

const script = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/highest-tag.mjs')

// A temporary repository with package.json at 0.5.22, never this repository's tags.
async function repository(t) {
    const cwd = await mkdtemp(join(tmpdir(), 'sekai-version-test-'))
    t.after(async () => {
        assert.equal(dirname(cwd), resolve(tmpdir()))
        await rm(cwd, { recursive: true, force: true })
    })
    const git = (...args) =>
        execFileSync(
            'git',
            ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
            { cwd, encoding: 'utf8' },
        ).trim()
    git('init', '--quiet')
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ version: '0.5.22' }))
    let count = 0
    const commit = () => {
        git('commit', '--quiet', '--allow-empty', '-m', `commit ${++count}`)
        return git('rev-parse', 'HEAD')
    }
    return { cwd, git, commit }
}

test("without tags the version is the package's", async (t) => {
    const { cwd, commit } = await repository(t)
    commit()
    assert.deepEqual(appVersion({ cwd }), {
        version: '0.5.22',
        appVersion: '0.5.22',
        atTag: false,
    })
})

test("without commits or git the version is the package's", async (t) => {
    const { cwd } = await repository(t)
    assert.equal(appVersion({ cwd }).appVersion, '0.5.22')
    const plain = await mkdtemp(join(tmpdir(), 'sekai-version-test-'))
    t.after(() => rm(plain, { recursive: true, force: true }))
    await writeFile(join(plain, 'package.json'), JSON.stringify({ version: '1.2.3' }))
    assert.deepEqual(appVersion({ cwd: plain }), {
        version: '1.2.3',
        appVersion: '1.2.3',
        atTag: false,
    })
})

test("at a tag the version is the tag's, not the package's", async (t) => {
    const { cwd, git, commit } = await repository(t)
    commit()
    git('tag', 'v0.6.0')
    assert.deepEqual(appVersion({ cwd }), {
        version: '0.6.0',
        appVersion: '0.6.0',
        atTag: true,
    })
})

test('after a tag the version adds the first 8 characters of the commit', async (t) => {
    const { cwd, git, commit } = await repository(t)
    commit()
    git('tag', 'v0.6.0')
    commit()
    const head = commit()
    assert.deepEqual(appVersion({ cwd }), {
        version: '0.6.0',
        appVersion: `0.6.0+${head.slice(0, 8)}`,
        atTag: false,
    })
})

test('the newest reachable tag counts, an annotated one too', async (t) => {
    const { cwd, git, commit } = await repository(t)
    commit()
    git('tag', 'v0.5.23')
    commit()
    git('tag', '-a', 'v0.6.0', '-m', 'Release')
    assert.equal(appVersion({ cwd }).appVersion, '0.6.0')
    git('checkout', '--quiet', 'v0.5.23')
    assert.equal(appVersion({ cwd }).appVersion, '0.5.23')
})

test('tags that are not vX.Y.Z are ignored', async (t) => {
    const { cwd, git, commit } = await repository(t)
    commit()
    for (const tag of ['release-9.9.9', '9.9.9', 'v9.9', 'v9.9.9-rc.1', 'v9.9.x', 'vnext'])
        git('tag', tag)
    assert.deepEqual(appVersion({ cwd }), {
        version: '0.5.22',
        appVersion: '0.5.22',
        atTag: false,
    })
    git('tag', 'v0.5.20')
    commit()
    assert.match(appVersion({ cwd }).appVersion, /^0\.5\.20\+[0-9a-f]{8}$/)
})

test('a four-part tag does not send the version back to package.json', async (t) => {
    const { cwd, git, commit } = await repository(t)
    commit()
    git('tag', 'v0.5.20')
    commit()
    git('tag', 'v9.9.9.9')
    assert.match(appVersion({ cwd }).appVersion, /^0\.5\.20\+[0-9a-f]{8}$/)
})

test('isHighestTag compares by version, not text', () => {
    assert.equal(isHighestTag('v0.5.23', ['v0.5.22', 'v0.5.23']), true)
    assert.equal(isHighestTag('v0.5.22', ['v0.5.22', 'v0.5.23']), false, 'a lower patch')
    assert.equal(isHighestTag('v0.5.23', ['v0.5.23', 'v0.6.0']), false, 'v0.5.23 against v0.6.0')
    assert.equal(isHighestTag('v0.10.0', ['v0.9.9', 'v0.10.0']), true, 'v0.10.0 against v0.9.9')
    assert.equal(isHighestTag('v0.9.9', ['v0.9.9', 'v0.10.0']), false)
    assert.equal(isHighestTag('v0.6.0', ['v0.6.0']), true)
    assert.equal(isHighestTag('v0.6.0', ['v0.6.0', 'v0.6.0']), true, 'an equal tag')
    assert.equal(isHighestTag('v0.6.0', ['v0.5.0']), true, 'a tag missing from the list')
    assert.equal(isHighestTag('v0.6.0', ['v0.6.0', 'v9.9.9-rc.1', 'v10', 'vnext', 'v1.0.x']), true)
    assert.equal(isHighestTag('v1.0.0', ['v0.6.0', 'v1.0.0', 'v1.0.1']), false)
    assert.equal(isHighestTag('v0.6.0', []), true)
    assert.equal(isHighestTag('v1.0', ['v0.6.0']), false, 'a tag that is not a version')
})

const run = (tag, stdin) =>
    spawnSync(process.execPath, [script, tag], {
        input: stdin,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_OUTPUT: '' },
    })

test("the deploy step reads git ls-remote's list", () => {
    const list = [
        'a1\trefs/tags/v0.5.22',
        'b2\trefs/tags/v0.6.0',
        'c3\trefs/tags/v0.10.0',
        'd4\trefs/tags/vnext',
    ].join('\n')
    const high = run('v0.10.0', list)
    assert.equal(high.status, 0)
    assert.match(high.stdout, /Deploying v0\.10\.0/)
    const low = run('v0.6.0', list)
    assert.equal(low.status, 0)
    assert.equal(low.stdout.trim(), 'Not deployed: v0.10.0 is higher than v0.6.0.')
    assert.equal(run('v0.6.0', '').status, 1, 'an unreadable list fails the run')
    assert.equal(run('v0.6.0', 'd4\trefs/tags/vnext\n').status, 1)
})
