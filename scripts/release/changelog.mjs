import { compareVersions, parseTag } from '../version.mjs'
import { ReleaseError } from './rules.mjs'

// CHANGELOG.md's format and its cut at a release.

const bullet = /^- (?:\((?:Web|Apps)\) )?(?!\()\S(?:.*\S)?$/
const released = /^## (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*) \((\d{4})-(\d{2})-(\d{2})\)$/
const contraction =
    /\b\w+n[’']t\b|\b(?:it|that|there|here|what|who|how|where|let)[’']s\b|\b\w+[’'](?:re|ve|ll|d|m)\b/i

/** Whether a line is a changelog or tag-message bullet: `- `, then an optional `(Web)` or `(Apps)`. */
export const isBullet = (line) => bullet.test(line)

const validDate = (year, month, day) => {
    const date = new Date(Date.UTC(year, month - 1, day))
    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
    )
}

/** `YYYY-MM-DD` in the local time zone. */
export const formatDate = (date) =>
    [date.getFullYear(), date.getMonth() + 1, date.getDate()]
        .map((part, index) => String(part).padStart(index ? 2 : 4, '0'))
        .join('-')

/** The problems with one bullet line, if any. */
function bulletProblems(line) {
    if (!bullet.test(line)) return ['not a "- " bullet with an optional (Web) or (Apps) prefix']
    const problems = []
    if (line.includes("'")) problems.push('use ’ for an apostrophe')
    if (contraction.test(line)) problems.push('no contractions')
    return problems
}

/**
 * Splits the text into `{ heading, lines }` sections and lists what breaks the format. A section's
 * `lines` are its bullets, whatever else the body holds.
 */
export function parseChangelog(text) {
    const problems = []
    const sections = []
    if (text.includes('\r')) problems.push('Lines must end with LF')
    if (!text.endsWith('\n') || text.endsWith('\n\n'))
        problems.push('The file must end with one newline')
    const lines = text.replace(/\n$/, '').split('\n')
    if (lines[0] !== '# Changelog') problems.push('The first line must be "# Changelog"')
    if (lines[1] !== '') problems.push('"# Changelog" must be followed by a blank line')
    let current
    for (const line of lines.slice(1)) {
        if (line.startsWith('#')) {
            current = { heading: line, body: [] }
            sections.push(current)
        } else if (current) current.body.push(line)
        else if (line) problems.push(`Text before the first section: ${line}`)
    }
    if (sections[0]?.heading !== '## Unreleased') problems.push('"## Unreleased" must come first')
    let previous
    for (const [index, section] of sections.entries()) {
        const { heading, body } = section
        const last = index === sections.length - 1
        if (index) {
            const match = released.exec(heading)
            if (!match) {
                problems.push(`Not "## X.Y.Z (YYYY-MM-DD)": ${heading}`)
            } else {
                if (!validDate(+match[4], +match[5], +match[6]))
                    problems.push(`Not a date: ${heading}`)
                const version = parseTag(`v${match[1]}.${match[2]}.${match[3]}`)
                if (previous && compareVersions(version, previous) >= 0)
                    problems.push(`Versions must decrease: ${heading}`)
                previous = version
            }
        }
        const inner = body.filter((line) => line !== '')
        const expected = inner.length ? ['', ...inner, ...(last ? [] : [''])] : last ? [] : ['']
        if (body.length !== expected.length || body.some((line, at) => line !== expected[at]))
            problems.push(`Layout of ${heading}: one blank line around a contiguous list of bullets`)
        for (const line of inner)
            for (const problem of bulletProblems(line)) problems.push(`${problem}: ${line}`)
        if (index && !inner.length) problems.push(`${heading} has no lines`)
        section.lines = inner
    }
    return { sections, problems }
}

/** The problems with a changelog's format; empty when it follows 4.2.4. */
export const checkChangelog = (text) => parseChangelog(text).problems

function parseValid(text) {
    const { sections, problems } = parseChangelog(text)
    if (problems.length) throw new ReleaseError(`CHANGELOG.md does not follow its format: ${problems[0]}`)
    return sections
}

const render = (sections) =>
    '# Changelog\n\n' +
    sections
        .map(({ heading, lines }) => [heading, ...(lines.length ? ['', ...lines] : [])].join('\n'))
        .join('\n\n') +
    '\n'

/** The `## Unreleased` lines. */
export const unreleasedLines = (text) => parseValid(text)[0].lines

/** The lines of a tag message; every line must be a bullet. */
export function messageLines(message) {
    const lines = message.split('\n').map((line) => line.trimEnd())
    while (lines.at(-1) === '') lines.pop()
    const wrong = lines.find((line) => !bullet.test(line))
    if (wrong !== undefined) throw new ReleaseError(`The notes are "- " bullets, one per line: ${wrong}`)
    return lines
}

/**
 * The changelog after releasing `version`: a section holding `notes`, and `released` (the
 * Unreleased lines at the tagged commit) removed from Unreleased, so lines added since stay. A
 * released line that is no longer there, reworded or removed, stops the cut.
 */
export function cutChangelog(text, { version, date, released: lines, notes }) {
    const [unreleased, ...rest] = parseValid(text)
    const remaining = [...unreleased.lines]
    for (const line of lines) {
        const at = remaining.indexOf(line)
        if (at < 0)
            throw new ReleaseError(
                `A released line was changed since the tagged commit. Edit CHANGELOG.md by hand: ${line}`,
            )
        remaining.splice(at, 1)
    }
    const heading = `## ${version} (${date})`
    if (rest.some((section) => section.heading.startsWith(`## ${version} `)))
        throw new ReleaseError(`CHANGELOG.md already has ${version}`)
    const result = render([
        { heading: unreleased.heading, lines: remaining },
        { heading, lines: notes },
        ...rest,
    ])
    const problems = checkChangelog(result)
    if (problems.length) throw new ReleaseError(`The cut changelog breaks its format: ${problems[0]}`)
    return result
}
