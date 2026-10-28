import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// The legal pages' revisions: each states one on its date, `<time datetime="…" data-revision="1">`,
// raised by a change that needs agreement again.

/** The legal pages, by name, and their files. */
export const LEGAL_PAGES = { privacy: 'privacy/index.html', terms: 'terms/index.html' }

/** The revision a page states: its one `data-revision`, a whole number of 1 or more. */
export function pageRevision(html, file) {
    const found = [...html.matchAll(/\bdata-revision="([^"]*)"/g)].map(([, value]) => value)
    if (found.length !== 1)
        throw new Error(`${file} must state one data-revision, not ${found.length}`)
    const [value] = found
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw new Error(`${file} has a data-revision that is not a whole number of 1 or more`)
    return Number(value)
}

/** The revisions of the legal pages a build has: none in the apps' build. */
export function legalPages(root, mode) {
    if (mode === 'native') return {}
    const revisions = {}
    for (const [name, file] of Object.entries(LEGAL_PAGES)) {
        const path = join(root, file)
        if (existsSync(path)) revisions[name] = pageRevision(readFileSync(path, 'utf8'), file)
    }
    return revisions
}
