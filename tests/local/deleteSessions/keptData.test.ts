import assert from 'node:assert/strict'
import test from 'node:test'
import { notSavedToFile, type SavedFacts } from '../../../src/local/keptData'

// keptData: whether a stored chain's work is in a file (Delete Sessions…, the stored twin of the
// page-close prompt).

const facts = (over: Partial<SavedFacts> = {}): SavedFacts => ({
    changed: false,
    hasContent: false,
    ...over,
})

test('a chain is not saved when it is bound and changed, bound by a download not confirmed, or unbound with content', () => {
    const table: [string, SavedFacts, boolean, boolean][] = [
        ['unbound, no content', facts(), false, false],
        ['unbound with content', facts({ hasContent: true }), false, true],
        ['bound by a save, unchanged', facts({ file: { event: 'saved' } }), false, false],
        ['bound by an open, unchanged', facts({ file: { event: 'opened' } }), false, false],
        ['bound and changed', facts({ file: { event: 'saved' }, changed: true }), false, true],
        ['bound by a download, unconfirmed', facts({ file: { event: 'downloaded' } }), false, true],
        ['… confirmed in this browser', facts({ file: { event: 'downloaded' } }), true, false],
        [
            '… confirmed by I Have the File',
            facts({ file: { event: 'downloaded', confirmed: true } }),
            false,
            false,
        ],
        ['an unknown event reads as a download', facts({ file: { event: 'sent' } }), false, true],
        ['a binding without an event is a download', facts({ file: {} }), false, true],
        [
            'a download confirmed here but changed since',
            facts({ file: { event: 'downloaded' }, changed: true }),
            true,
            true,
        ],
        [
            'content is not enough when a file holds it',
            facts({ file: { event: 'saved' }, hasContent: true }),
            false,
            false,
        ],
        [
            'a chain this build cannot read counts as not saved',
            facts({ readable: 'newer' }),
            true,
            true,
        ],
        [
            '… even bound and unchanged',
            facts({ readable: 'newer', file: { event: 'saved' } }),
            true,
            true,
        ],
    ]
    for (const [what, input, confirmedHere, expected] of table)
        assert.equal(notSavedToFile(input, confirmedHere), expected, what)
})
