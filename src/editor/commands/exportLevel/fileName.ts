// The portable name checks (forbidden and control characters, a dot or space at either end,
// reserved names, the length), which the web's File Name fields run, and the replacement that
// makes a name the editor suggests valid.

export type NameProblem =
    | { reason: 'invalidChar'; char: string }
    | { reason: 'controlChar' }
    | { reason: 'edgeDotSpace' }
    | { reason: 'reserved'; name: string }
    | { reason: 'tooLong' }

/** About 200 UTF-8 bytes, so " (2)" and an extension still fit 255. */
export const NAME_BYTE_LIMIT = 200

const forbidden = /[\\/:*?"<>|]/
// eslint-disable-next-line no-control-regex
const control = /[\u0000-\u001f\u007f]/
const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

const byteLength = (text: string) => new TextEncoder().encode(text).length

/** The reserved name a file name starts with, with or without an extension. */
const reservedStem = (name: string) => {
    const stem = name.split('.')[0] ?? ''
    return reserved.test(stem) ? stem : undefined
}

/** The first rule a typed name breaks; an empty name breaks none. */
export const nameProblem = (name: string): NameProblem | undefined => {
    const char = forbidden.exec(name)?.[0]
    if (char) return { reason: 'invalidChar', char }
    if (control.test(name)) return { reason: 'controlChar' }
    const stem = reservedStem(name)
    if (stem) return { reason: 'reserved', name: stem }
    if (/^[. ]|[. ]$/.test(name)) return { reason: 'edgeDotSpace' }
    if (byteLength(name) > NAME_BYTE_LIMIT) return { reason: 'tooLong' }
}

/** A forbidden character or a reserved name shows at once; the rest after a pause. */
export const showsAtOnce = (problem: NameProblem) =>
    problem.reason === 'invalidChar' ||
    problem.reason === 'controlChar' ||
    problem.reason === 'reserved'

/** Makes a name the editor suggests valid by the one replacement the rules give. */
export const validName = (name: string) => {
    let result = name
        .normalize('NFC')
        .replaceAll(':', '.')
        // eslint-disable-next-line no-control-regex
        .replace(/[\\/*?"<>|\u0000-\u001f\u007f]/g, '-')
        .replace(/^[. ]+|[. ]+$/g, '')
    const stem = reservedStem(result)
    if (stem) result = `${stem}-${result.slice(stem.length)}`
    if (byteLength(result) > NAME_BYTE_LIMIT) {
        // Cut by grapheme, so no character is split.
        const characters = Array.from(
            new Intl.Segmenter().segment(result),
            ({ segment }) => segment,
        )
        while (characters.length && byteLength(`${characters.join('')}…`) > NAME_BYTE_LIMIT)
            characters.pop()
        result = `${characters.join('')}…`
    }
    return result.normalize('NFC')
}

/**
 * A file name as file systems compare it: composed and in lower case, with no locale rules, so
 * "INDEX" and "index" are one name on a Turkish system too.
 */
export const nameKey = (name: string) => name.normalize('NFC').toLowerCase()
