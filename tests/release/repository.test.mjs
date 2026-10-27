import assert from 'node:assert/strict'
import test from 'node:test'
import {
    defaultRepository,
    parseGithubRemote,
    sourceRepository,
} from '../../scripts/repository.mjs'

test('parseGithubRemote reads https and ssh forms', () => {
    for (const url of [
        'https://github.com/a/b',
        'https://github.com/a/b.git',
        'https://github.com/a/b/',
        'https://user:token@github.com/a/b.git',
        'git@github.com:a/b.git',
        'git@github.com:a/b',
        'ssh://git@github.com/a/b.git',
    ]) {
        assert.equal(parseGithubRemote(url), 'a/b', url)
    }
    assert.equal(parseGithubRemote('https://github.com/a/b.c-d_e'), 'a/b.c-d_e')
})

test('parseGithubRemote rejects other hosts and shapes', () => {
    for (const url of ['https://gitlab.com/a/b', 'D:/some/path', '', 'https://github.com/a']) {
        assert.equal(parseGithubRemote(url), undefined, url)
    }
})

test('sourceRepository prefers origin, then the environment, then the default', () => {
    const env = { GITHUB_REPOSITORY: 'x/test-site' }
    assert.equal(sourceRepository({ env, origin: 'https://github.com/a/b.git' }), 'a/b')
    assert.equal(sourceRepository({ env, origin: 'https://example.com/a/b' }), 'x/test-site')
    assert.equal(sourceRepository({ env: {}, origin: '' }), defaultRepository)
})
