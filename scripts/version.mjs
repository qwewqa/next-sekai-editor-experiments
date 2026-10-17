import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const versionTag = /^v(\d+)\.(\d+)\.(\d+)$/

const git = (cwd, ...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

/** The release version from the newest reachable `vX.Y.Z` tag, else `package.json`'s (Part 4, 4.2.1). */
export function appVersion({ cwd = process.cwd() } = {}) {
    cwd = resolve(cwd)
    try {
        // Exact vX.Y.Z tags only; a glob would also take v1.2.3.4.
        const tags = git(cwd, 'tag', '--merged', 'HEAD')
            .split('\n')
            .filter((tag) => versionTag.test(tag))
        if (!tags.length) throw new Error('No version tags')
        // A long form always has the distance.
        const described = git(
            cwd,
            'describe',
            '--tags',
            '--long',
            '--abbrev=8',
            ...tags.flatMap((tag) => ['--match', tag]),
        )
        const match = /^(v\d+\.\d+\.\d+)-(\d+)-g[0-9a-f]+$/.exec(described)
        if (match && versionTag.test(match[1])) {
            const version = match[1].slice(1)
            if (match[2] === '0') return { version, appVersion: version, atTag: true }
            const commit = git(cwd, 'rev-parse', 'HEAD').slice(0, 8)
            return { version, appVersion: `${version}+${commit}`, atTag: false }
        }
    } catch {
        // No tags, no commits or no git: the package version below.
    }
    const { version } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
    return { version, appVersion: version, atTag: false }
}

const parse = (tag) => {
    const match = versionTag.exec(tag)
    return match && match.slice(1).map(Number)
}

const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/** Whether `tag` is the highest version tag in `tags`; tags that aren't `vX.Y.Z` are ignored. */
export function isHighestTag(tag, tags) {
    const mine = parse(tag)
    if (!mine) return false
    return tags.every((other) => {
        const theirs = parse(other)
        return !theirs || compare(theirs, mine) <= 0
    })
}
