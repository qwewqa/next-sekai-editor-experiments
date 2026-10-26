import { execFileSync, execSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cutChangelog, formatDate, messageLines, unreleasedLines } from './changelog.mjs'
import {
    ReleaseError,
    checkNewVersion,
    checkFixtures,
    checkPatchFormats,
    fixturePaths,
    fixturePins,
    fixtureShip,
    localChecks,
    parseArgs,
    readFixturesConfirmedAt,
    readFormatVersions,
    usage,
} from './rules.mjs'

// `npm run release:tag -- X.Y.Z [--commit <sha>] [--edit]`. The rules are in
// rules.mjs and changelog.mjs; this file only runs git and gh.

const run = (command, args, options = {}) =>
    execFileSync(command, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...options,
    }).trim()
const git = (...args) => run('git', args)
// A file's text exactly: run() trims, which would drop the final newline the format requires.
const show = (revision, file) =>
    execFileSync('git', ['show', `${revision}:${file}`], { encoding: 'utf8' })
const succeeds = (command, args) => spawnSync(command, args, { stdio: 'ignore' }).status === 0

function remoteTags() {
    try {
        return git('ls-remote', '--tags', 'origin')
            .split('\n')
            .map((line) =>
                line
                    .split('\t')[1]
                    ?.replace(/^refs\/tags\//, '')
                    .replace(/\^\{\}$/, ''),
            )
            .filter(Boolean)
    } catch {
        throw new ReleaseError('Could not read the tags on origin.')
    }
}

// A file's text at a revision, or null when the revision has no such file.
const showAt = (revision) => (file) =>
    succeeds('git', ['cat-file', '-e', `${revision}:${file}`])
        ? show(revision, file)
        : null

function requireGh() {
    if (!succeeds('gh', ['--version'])) throw new ReleaseError('The GitHub CLI (gh) is missing.')
    if (!succeeds('gh', ['auth', 'status'])) throw new ReleaseError('Sign in with: gh auth login')
}

// browsers-full.yml does not run on a push to main, so a release starts it by hand.
function requirePassedRuns(commit, head) {
    for (const workflow of ['check.yml', 'deploy-pages.yml', 'browsers-full.yml']) {
        const runs = JSON.parse(
            run('gh', [
                'run',
                'list',
                '--workflow',
                workflow,
                '--commit',
                commit,
                '--status',
                'success',
                '--json',
                'databaseId',
                '--limit',
                '1',
            ]),
        )
        if (!runs.length)
            throw new ReleaseError(
                `${workflow} has not passed for ${commit}.` +
                    (workflow === 'browsers-full.yml'
                        ? commit === head
                            ? ` Start it with: gh workflow run ${workflow} --ref main`
                            : ` Push it to a ci/ branch to run it, for example: git push origin ${commit}:refs/heads/ci/release`
                        : ''),
            )
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) {
        console.log(usage)
        return
    }
    const { version, edit } = args
    process.chdir(git('rev-parse', '--show-toplevel'))

    // 1. A clean tree on main equal to origin/main, or on a short branch from a version tag.
    if (git('status', '--porcelain', '--untracked-files=no'))
        throw new ReleaseError('The working tree has changes. Commit them first.')
    if (!succeeds('git', ['symbolic-ref', '-q', 'HEAD']))
        throw new ReleaseError('HEAD is detached. Switch to main or a branch.')
    const branch = git('symbolic-ref', '--short', 'HEAD')
    const head = git('rev-parse', 'HEAD')
    const onMain = branch === 'main'
    if (onMain) {
        requireGh()
        git('fetch', 'origin', 'main')
        if (head !== git('rev-parse', 'origin/main'))
            throw new ReleaseError('main differs from origin/main. Pull or push first.')
    } else if (
        !succeeds('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*.[0-9]*.[0-9]*'])
    ) {
        throw new ReleaseError(
            `${branch} is not main and does not come from a version tag. Release from main or a branch made from the last tag.`,
        )
    }

    // 2. The version.
    const tags = [...new Set([...git('tag', '--list', 'v*').split('\n'), ...remoteTags()])]
    const newest = checkNewVersion(version, tags)

    // 3. The commit, the formats of a patch version, and CI.
    const commit = args.commit ? git('rev-parse', '--verify', `${args.commit}^{commit}`) : head
    if (!succeeds('git', ['merge-base', '--is-ancestor', commit, 'HEAD']))
        throw new ReleaseError(`${commit} is not in the history of ${branch}.`)
    if (newest)
        checkPatchFormats(
            version,
            newest,
            readFormatVersions(showAt(newest)),
            readFormatVersions(showAt(commit)),
        )
    if (version === fixtureShip) {
        // Only the ship tag: the fixtures are the output of the code it names.
        const at = readFixturesConfirmedAt(showAt(commit)(fixturePins))
        if (!succeeds('git', ['merge-base', '--is-ancestor', at, commit]))
            throw new ReleaseError(
                `The v1 fixtures are confirmed at ${at}, which is not in the history of ${commit}. Merge their branch with a merge commit, not a squash or a rebase.`,
            )
        const changed = git('diff', '--name-only', at, commit, '--', ...fixturePaths)
            .split('\n')
            .filter(Boolean)
        checkFixtures(version, at, changed)
    }
    if (onMain) requirePassedRuns(commit, head)

    // 4. What is in and out.
    const notes = unreleasedLines(show(commit, 'CHANGELOG.md'))
    if (!notes.length) throw new ReleaseError(`No lines under ## Unreleased at ${commit}.`)
    console.log(`v${version} at ${commit.slice(0, 8)} on ${branch}:\n${notes.join('\n')}`)
    if (commit !== head) console.log(`\nLeft out of this tag:\n${git('log', '--oneline', `${commit}..HEAD`)}`)
    if (!onMain) {
        const node = readFileSync('.node-version', 'utf8').trim()
        console.log(
            `\nCI does not check ${branch} before the tag is pushed. Run these under Node ${node} first:\n${localChecks.join('\n')}`,
        )
    }

    // The cut is tried before the tag exists, so a reworded line stops the release first.
    const date = formatDate(new Date())
    const changelog = readFileSync('CHANGELOG.md', 'utf8')
    cutChangelog(changelog, { version, date, released: notes, notes })

    // 5. The annotated tag, with the notes as its message.
    const tag = `v${version}`
    const folder = mkdtempSync(join(tmpdir(), 'release-tag-'))
    try {
        const message = join(folder, 'message.txt')
        writeFileSync(message, notes.join('\n') + '\n')
        execFileSync('git', ['tag', '-a', ...(edit ? ['-e'] : []), '-F', message, tag, commit], {
            stdio: 'inherit',
        })
    } finally {
        rmSync(folder, { recursive: true, force: true })
    }

    // 6. The changelog commit. A failure here removes the tag, which was never pushed.
    const files = ['CHANGELOG.md', 'package.json', 'package-lock.json']
    try {
        const final = messageLines(git('tag', '--list', '--format=%(contents)', tag))
        writeFileSync(
            'CHANGELOG.md',
            cutChangelog(changelog, { version, date, released: notes, notes: final }),
        )
        if (JSON.parse(readFileSync('package.json', 'utf8')).version !== version)
            execSync(`npm version ${version} --no-git-tag-version --ignore-scripts`, { stdio: 'ignore' })
        git('add', ...files)
        git('commit', '-m', `Changelog for ${version}`)
    } catch (error) {
        spawnSync('git', ['reset', '--quiet', 'HEAD', '--', ...files])
        spawnSync('git', ['checkout', '--', ...files])
        spawnSync('git', ['tag', '-d', tag])
        throw error
    }

    // 7. The push is the release.
    console.log(`\nMade ${tag} and the changelog commit. To release, run:\n`)
    console.log(`git push --atomic origin ${branch} ${tag}`)
}

try {
    main()
} catch (error) {
    if (error instanceof ReleaseError) console.error(error.message)
    else console.error(error)
    process.exit(1)
}
