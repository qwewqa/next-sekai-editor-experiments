import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// B4 acceptance (work/arch/spec-B.md, invariants 1 and 2): a save picker is opened only in the
// pick-session module, and a Save's reservation is ended only through SaveAttempt. The Save family
// (the write-back, Replace, Download Again and the Save pickers) opens its picker and ends its
// reservation there since B2; Export's and Save to File…'s pickers still open their own and end
// their own reservation, so these fail. They are `todo` so the suite stays green, and B4 removes
// the `todo` when it turns them green.

const root = fileURLToPath(new URL('../../../src/', import.meta.url))

/** The only module that may open a save picker (B1's pick session). */
const PICK_SESSION = 'editor/save/pickSession.ts'
/** The only module that may end a reservation (B1's SaveAttempt). */
const SAVE_ATTEMPT = 'editor/save/saveAttempt.ts'
/** The flusher owns `endSave`; the platforms own `pickSaveFile` and the picker option. */
const OWNERS = ['local/flush.ts']
const PLATFORM = `platform${sep}`

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

test(
    'B4 acceptance: pickers are opened only in the pick-session module',
    { todo: 'B2 to B4 move every picker onto the pick session (work/arch/spec-B.md §6)' },
    () => {
        // `pickSaveFile(` is a call of the platform's picker; `picker:` in a request is the
        // platform's `saveFile` opening one (Export's).
        const opened = sites(/\bpickSaveFile\s*\(|\bpicker:\s*\{/, [PICK_SESSION], (file) =>
            file.startsWith(PLATFORM),
        )
        assert.deepEqual(opened, [], 'save pickers opened outside the pick session')
    },
)

test(
    'B4 acceptance: reservations are ended only through SaveAttempt',
    { todo: 'B2 to B4 move every endSave onto SaveAttempt (work/arch/spec-B.md §6)' },
    () => {
        const ended = sites(/\b(endSave|release)\s*\(/, [SAVE_ATTEMPT, ...OWNERS])
        assert.deepEqual(ended, [], 'reservations ended outside SaveAttempt')
    },
)
