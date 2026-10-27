import assert from 'node:assert/strict'
import test from 'node:test'
import { notSavedToFile, type SavedFacts } from '../../../src/local/keptData'

// keptData: whether a stored chain's work is in a file (Delete Sessions…, the stored twin of the
// page-close prompt).

const facts = (over: Partial<SavedFacts> = {}): SavedFacts => ({
    bound: false,
    changed: false,
    hasContent: false,
    ...over,
})

test('a chain is not saved when it is bound and changed, or unbound with content', () => {
    const table: [string, SavedFacts, boolean][] = [
        ['unbound, no content', facts(), false],
        ['unbound with content', facts({ hasContent: true }), true],
        ['bound, unchanged', facts({ bound: true }), false],
        ['bound and changed', facts({ bound: true, changed: true }), true],
        [
            'content is not enough when a file holds it',
            facts({ bound: true, hasContent: true }),
            false,
        ],
        ['a chain this build cannot read counts as not saved', facts({ readable: 'newer' }), true],
        ['… even bound and unchanged', facts({ readable: 'damaged', bound: true }), true],
    ]
    for (const [what, input, expected] of table) assert.equal(notSavedToFile(input), expected, what)
})
