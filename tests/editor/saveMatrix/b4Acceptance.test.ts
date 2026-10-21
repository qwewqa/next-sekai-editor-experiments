import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// B4 acceptance (work/arch/spec-B.md, invariants 1 and 2): a save picker is opened only in the
// pick-session module, a Save's reservation is taken and ended only through SaveAttempt, and
// `nse-bind` is held exclusive only by the pick session. Every Save, Export and Save to File… run
// on the session since B4.

const root = fileURLToPath(new URL('../../../src/', import.meta.url))

/** The only module that may open a save picker and hold `nse-bind` exclusive (B2's pick session). */
const PICK_SESSION = 'editor/save/pickSession.ts'
/** The only module that may take and end a Save's reservation (B1's SaveAttempt). */
const SAVE_ATTEMPT = 'editor/save/saveAttempt.ts'
/** The flusher owns the reservation; the platforms own `pickSaveFile`. */
const OWNERS = ['local/flush.ts']
const PLATFORM = `platform${sep}`
/** The aids that drive the flusher in the specs. */
const TESTING = `local${sep}testing${sep}`

const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) return sources(path)
        return /\.(ts|vue)$/.test(name) ? [path] : []
    })

/** Lines of code (not comments) in a file that match `pattern`, as `file:line`. */
const sites = (
    pattern: RegExp,
    allowed: string[],
    skip: (file: string) => boolean = () => false,
) => {
    const found: string[] = []
    for (const path of sources(root)) {
        const file = relative(root, path)
        if (skip(file) || allowed.includes(file.split(sep).join('/'))) continue
        readFileSync(path, 'utf8')
            .split('\n')
            .forEach((line, i) => {
                const code = line.trim()
                if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return
                if (pattern.test(code)) found.push(`${file.split(sep).join('/')}:${i + 1}`)
            })
    }
    return found
}

test('B4 acceptance: pickers are opened only in the pick-session module', () => {
    // `pickSaveFile(` is a call of the platform's picker; `picker:` in a request would be a
    // `saveFile` opening one.
    const opened = sites(/\bpickSaveFile\s*\(|\bpicker:\s*\{/, [PICK_SESSION], (file) =>
        file.startsWith(PLATFORM),
    )
    assert.deepEqual(opened, [], 'save pickers opened outside the pick session')
})

test('B4 acceptance: reservations are taken and ended only through SaveAttempt', () => {
    const allowed = [SAVE_ATTEMPT, ...OWNERS]
    const skip = (file: string) => file.startsWith(TESTING)
    assert.deepEqual(
        sites(/\breserveSave\s*\(/, allowed, skip),
        [],
        'reservations taken outside SaveAttempt',
    )
    assert.deepEqual(
        sites(/\b(endSave|flusher\.release)\s*\(/, allowed, skip),
        [],
        'reservations ended outside SaveAttempt',
    )
})

test('B4 acceptance: nse-bind is held exclusive only by the pick session', () => {
    const held = sites(/withBind\(\s*'exclusive'/, [PICK_SESSION])
    assert.deepEqual(held, [], 'nse-bind held exclusive outside the pick session')
})
