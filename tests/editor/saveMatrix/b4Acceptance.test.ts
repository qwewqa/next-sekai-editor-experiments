import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// B4 acceptance (work/soundness/architecture-review.md §B.6 item 2, §B.7): once the pick session
// and SaveAttempt exist, a save picker is opened only in the pick-session module, and a Save's
// reservation is ended only through SaveAttempt. Today every path opens its own picker and ends
// its own reservation, so these fail; they are `todo` so the suite stays green, and B4 removes
// the `todo` when it turns them green. The two allowed modules are named here: B1 may rename them.

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
    { todo: 'B1 to B4 move every picker onto the pick session (architecture-review.md §B.7)' },
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
    { todo: 'B1 to B4 move every endSave onto SaveAttempt (architecture-review.md §B.7)' },
    () => {
        const ended = sites(/\bendSave\s*\(/, [SAVE_ATTEMPT, ...OWNERS])
        assert.deepEqual(ended, [], 'reservations ended outside SaveAttempt')
    },
)
