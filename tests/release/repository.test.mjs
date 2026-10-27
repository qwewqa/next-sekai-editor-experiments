import assert from 'node:assert/strict'
import test from 'node:test'
import {
    defaultRepository,
    parseGithubRemote,
    sourceRepository,
} from '../../scripts/repository.mjs'

test('parseGithubRemote reads https, ssh and git URLs and the scp form', () => {
    for (const url of [
        'https://github.com/a/b',
        'https://github.com/a/b.git',
        'https://github.com/a/b/',
        'https://www.github.com/a/b.git',
        'https://github.com:443/a/b.git',
        'https://user:token@github.com/a/b.git',
        'https://user:p%40ss@github.com:443/a/b',
        'https://us@er:pa@ss@github.com/a/b',
        'http://github.com/a/b',
        'HTTPS://GitHub.com/a/b.git',
        'ssh://git@github.com/a/b.git',
        'ssh://git@github.com:22/a/b.git',
        'ssh://git@ssh.github.com:443/a/b.git',
        'ssh://ssh.github.com:443/a/b',
        'ssh://user:token@ssh.github.com:443/a/b.git',
        'git://github.com/a/b.git',
        'git@github.com:a/b.git',
        'git@github.com:a/b',
        'git@ssh.github.com:a/b.git',
        'git@www.github.com:a/b.git',
        'github.com:a/b.git',
    ]) {
        assert.equal(parseGithubRemote(url), 'a/b', url)
    }
    assert.equal(parseGithubRemote('https://github.com/a/b.c-d_e'), 'a/b.c-d_e')
})

test('parseGithubRemote never returns credentials', () => {
    for (const url of [
        'https://user:secret@github.com/a/b.git',
        'https://secret@github.com:443/a/b',
        'ssh://secret:secret@ssh.github.com:443/a/b.git',
    ]) {
        assert.doesNotMatch(parseGithubRemote(url), /secret|@|:/, url)
    }
})

test('parseGithubRemote rejects other hosts and shapes', () => {
    for (const url of [
        // Other hosts, including ones that only look like GitHub.
        'https://gitlab.com/a/b',
        'https://example.com/a/b',
        'git@gitlab.com:a/b.git',
        'ssh://git@gitlab.com:443/a/b.git',
        'https://github.com.evil.com/a/b',
        'https://evilgithub.com/a/b',
        'https://api.github.com/a/b',
        'https://gist.github.com/a/b',
        'ssh://git@evil.ssh.github.com:443/a/b.git',
        'https://github.com@evil.com/a/b',
        'https://evil.com/x@github.com/a/b',
        'https://evil.com:443/github.com/a/b',
        'git@github.com.evil.com:a/b.git',
        // Not owner/repo.
        'https://github.com',
        'https://github.com/',
        'https://github.com/a',
        'https://github.com/a/',
        'https://github.com/a/b/c',
        'https://github.com/a/b/c.git',
        'ssh://git@ssh.github.com:443/a',
        'ssh://git@ssh.github.com:443/a/b/c.git',
        'git@github.com:a',
        'git@github.com:a/b/c.git',
        'https://github.com/a/b?x=1',
        'https://github.com/a/b#x',
        // Not a URL.
        'D:/some/path',
        'file:///c/github.com/a/b',
        'ftp://github.com/a/b',
        '',
    ]) {
        assert.equal(parseGithubRemote(url), undefined, url)
    }
})

test('sourceRepository prefers origin, then the environment, then the default', () => {
    const env = { GITHUB_REPOSITORY: 'x/test-site' }
    assert.equal(sourceRepository({ env, origin: 'https://github.com/a/b.git' }), 'a/b')
    assert.equal(sourceRepository({ env, origin: 'https://example.com/a/b' }), 'x/test-site')
    assert.equal(sourceRepository({ env, origin: 'ssh://git@ssh.github.com:443/a/b.git' }), 'a/b')
    assert.equal(sourceRepository({ env: {}, origin: '' }), defaultRepository)
})
