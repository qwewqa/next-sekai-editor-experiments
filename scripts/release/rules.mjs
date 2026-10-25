import { compareVersions, isHighestTag, parseTag } from '../version.mjs'

// The checks of `release:tag` that need neither git nor gh; tag.mjs runs them.

/** An expected stop: tag.mjs prints its message alone. */
export class ReleaseError extends Error {}

export const usage = 'Usage: npm run release:tag -- X.Y.Z [--commit <sha>] [--edit]'

const plainVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/

/** The arguments after `--`: `{ help }` or `{ version, commit, edit }`. */
export function parseArgs(argv) {
    let version
    let commit
    let edit = false
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index]
        if (arg === '--help' || arg === '-h') return { help: true }
        if (arg === '--edit') edit = true
        else if (arg === '--commit' || arg.startsWith('--commit=')) {
            if (commit !== undefined) throw new ReleaseError('--commit is given twice.')
            commit = arg === '--commit' ? argv[++index] : arg.slice('--commit='.length)
            if (!commit || !/^[0-9a-f]{7,40}$/i.test(commit))
                throw new ReleaseError('--commit takes a commit hash of 7 to 40 hex digits.')
        } else if (arg.startsWith('-')) throw new ReleaseError(`Unknown option: ${arg}`)
        else if (version !== undefined) throw new ReleaseError(`Unexpected argument: ${arg}`)
        else version = arg
    }
    if (version === undefined) throw new ReleaseError(`The version is missing. ${usage}`)
    if (!plainVersion.test(version))
        throw new ReleaseError(`The version is X.Y.Z, with no "v" or suffix: ${version}`)
    return { version, commit, edit }
}

/** The highest `vX.Y.Z` tag of `tags`, or undefined; other names are ignored. */
export const newestTag = (tags) => tags.find((tag) => isHighestTag(tag, tags))

/** Stops unless `version` is new and above every version tag; returns the newest tag, if any. */
export function checkNewVersion(version, tags) {
    if (tags.includes(`v${version}`)) throw new ReleaseError(`v${version} exists already.`)
    const newest = newestTag(tags)
    if (newest && compareVersions(parseTag(`v${version}`), parseTag(newest)) <= 0)
        throw new ReleaseError(`${version} must be greater than ${newest}.`)
    return newest
}

/** A patch version: the last number is not 0 (a minor version is X.Y.0). */
export const isPatchVersion = (version) => Number(version.split('.')[2]) > 0

/**
 * The format versions the build writes, in the source (docs/format-versioning.md).
 * `RECORDS_V` is also the root `v`. The `.nxsp` major and the manifest version are written to
 * files too. The IndexedDB `DB_VERSION`/`FORMAT_VERSION` are left out: a fix may raise them to
 * stop old tabs.
 */
export const formatConstants = [
    { name: 'LEVEL_VERSION', file: 'src/levelData/levelVersion.ts' },
    { name: 'RECORDS_V', file: 'src/local/records/version.ts' },
    { name: 'NXSP_VERSION', file: 'src/local/nxsp/version.ts' },
    { name: 'NXSP_MINOR', file: 'src/local/nxsp/version.ts' },
    { name: 'NXSP_PATCH', file: 'src/local/nxsp/version.ts' },
    { name: 'MANIFEST_VERSION', file: 'src/local/nxsp/version.ts' },
]

/**
 * Each constant's number at one revision. `read(file)` gives a file's text, or null when the
 * revision has no such file (then the number is null). A file without its constant stops the
 * release: the table above is out of date, and a silent skip would disable the check.
 */
export function readFormatVersions(read) {
    const versions = {}
    for (const { name, file } of formatConstants) {
        const text = read(file)
        if (text === null) {
            versions[name] = null
            continue
        }
        const match = new RegExp(`^export const ${name} = (\\d+)\\b`, 'm').exec(text)
        if (!match)
            throw new ReleaseError(`Cannot find ${name} in ${file}. Update formatConstants.`)
        versions[name] = Number(match[1])
    }
    return versions
}

/** The constants whose numbers differ, as `{ name, before, after }`. */
export const changedFormatVersions = (before, after) =>
    formatConstants
        .filter(({ name }) => before[name] !== after[name])
        .map(({ name }) => ({ name, before: before[name], after: after[name] }))

/** Stops a patch version when a written format version changed since the last tag. */
export function checkPatchFormats(version, newest, before, after) {
    if (!isPatchVersion(version)) return
    const changed = changedFormatVersions(before, after)
    if (!changed.length) return
    const list = changed.map(({ name, before, after }) => `${name} ${before ?? 'none'} to ${after ?? 'none'}`)
    throw new ReleaseError(
        `${version} is a patch version, but the formats changed since ${newest}: ${list.join(', ')}. ` +
            'Use a minor version.',
    )
}

/** The local checks for a branch that CI does not check before the tag (CONTRIBUTING, Releasing). */
export const localChecks = [
    'npm run check-type',
    'npm run check-lint',
    'npm run check-format',
    'npm test',
    'npm run test:release',
    'npm run build:release',
    'npm run test:production',
    'npm run check:release',
]
