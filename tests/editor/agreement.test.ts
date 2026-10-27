import assert from 'node:assert/strict'
import test from 'node:test'
import { agreed, asked, changeOf, isDue, recordOf } from '../../src/editor/agreement/rules'
import { linkParts } from '../../src/utils/linkParts'

// When the agreement dialog is due, its line on a reprompt and what Agree stores. The module that
// reads the page from these rules needs the app's bundler; the browser specs (agreement.spec.ts,
// analytics.spec.ts) cover it.

const current = { terms: 2, privacy: 3 }

test('a stored record reads as its whole-number fields; anything but an object is none', () => {
    for (const stored of [undefined, null, 1, '{"terms":1,"privacy":1}', true])
        assert.equal(recordOf(stored), undefined, String(stored))
    assert.deepEqual(recordOf({ terms: 1, privacy: 4 }), { terms: 1, privacy: 4 })
    assert.deepEqual(recordOf({ terms: 1 }), { terms: 1, privacy: 0 })
    assert.deepEqual(recordOf({}), { terms: 0, privacy: 0 })
    assert.deepEqual(recordOf({ terms: -1, privacy: 1.5 }), { terms: 0, privacy: 0 })
    assert.deepEqual(recordOf({ terms: '2', privacy: NaN }), { terms: 0, privacy: 0 })
})

test('the build asks only with both pages', () => {
    assert.deepEqual(asked({ terms: 2, privacy: 3 }), current)
    assert.equal(asked({ privacy: 3 }), undefined)
    assert.equal(asked({ terms: 2 }), undefined)
    assert.equal(asked({}), undefined)
})

test('due without a record, or with either page below the build', () => {
    assert.equal(isDue(current, undefined), true)
    assert.equal(isDue(current, { terms: 1, privacy: 3 }), true)
    assert.equal(isDue(current, { terms: 2, privacy: 2 }), true)
    assert.equal(isDue(current, { terms: 2, privacy: 3 }), false)
    assert.equal(isDue(current, { terms: 5, privacy: 9 }), false)
    // A build without both pages never asks.
    assert.equal(isDue(asked({ privacy: 3 }), undefined), false)
})

test('the line says which page changed, and a first agreement has none', () => {
    assert.equal(changeOf(current, undefined), undefined)
    assert.equal(changeOf(current, { terms: 1, privacy: 3 }), 'terms')
    assert.equal(changeOf(current, { terms: 2, privacy: 0 }), 'privacy')
    assert.equal(changeOf(current, { terms: 0, privacy: 0 }), 'both')
    assert.equal(changeOf(current, { terms: 2, privacy: 3 }), undefined)
})

test('Agree stores the higher of the record and the build, per page, so it never lowers one', () => {
    assert.deepEqual(agreed(current, undefined), current)
    assert.deepEqual(agreed(current, { terms: 5, privacy: 0 }), { terms: 5, privacy: 3 })
    assert.deepEqual(agreed(current, { terms: 0, privacy: 9 }), { terms: 2, privacy: 9 })
})

test('a sentence splits around its links, keeping the characters that touch each one', () => {
    assert.deepEqual(linkParts('Read the Terms and the Notice.', ['Terms', 'Notice']), [
        { text: 'Read the ' },
        { link: 0, name: 'Terms', lead: '', trail: '' },
        { text: ' and the ' },
        { link: 1, name: 'Notice', lead: '', trail: '.' },
    ])
    // A French l’ and a Turkish suffix stay with their link; the links may come in either order.
    assert.deepEqual(linkParts('lu l’Avis et les Conditions’nı', ['Conditions', 'Avis']), [
        { text: 'lu l' },
        { link: 1, name: 'Avis', lead: '’', trail: '' },
        { text: ' et les ' },
        { link: 0, name: 'Conditions', lead: '', trail: '’' },
        { text: 'nı' },
    ])
    // Missing or repeated, a name is not linked: the sentence shows as it is.
    assert.equal(linkParts('Read the Terms.', ['Terms', 'Notice']), undefined)
    assert.equal(linkParts('Terms and Terms', ['Terms']), undefined)
})
