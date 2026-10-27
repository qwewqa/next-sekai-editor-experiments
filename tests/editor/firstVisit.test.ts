import assert from 'node:assert/strict'
import test from 'node:test'
import {
    blocking,
    FIRST_VISIT_REVISION,
    firstVisitDue,
    isDue,
    type OpenFacts,
} from '../../src/editor/firstVisit/rules'
import { LOAD_ORDER } from '../../src/editor/loadOrder'

// When the first-visit dialog shows: due at module evaluation, then shown, skipped or waiting at the
// gate's lifting. The module that reads the page from these rules needs the app's bundler; the
// browser specs (firstVisit.spec.ts, analytics.spec.ts) cover it.

const due = { offered: true, safeMode: false, stored: undefined }

const facts = (overrides: Partial<OpenFacts> = {}): OpenFacts => ({
    ...due,
    phase: 'done',
    blocking: false,
    modalOpen: false,
    visible: true,
    keep: () => true,
    ...overrides,
})

test('due in a build that offers it, outside safe mode, while the mark is missing or older', () => {
    assert.equal(isDue(due), true)
    assert.equal(isDue({ ...due, offered: false }), false)
    assert.equal(isDue({ ...due, safeMode: true }), false)
    assert.equal(isDue({ ...due, stored: FIRST_VISIT_REVISION - 1 }), true)
    assert.equal(isDue({ ...due, stored: FIRST_VISIT_REVISION }), false)
    assert.equal(isDue({ ...due, stored: FIRST_VISIT_REVISION + 1 }), false)
})

test('a malformed mark reads as none, so the dialog shows and writes it again', () => {
    for (const stored of ['1', 'x', null, {}, [], 0.5, Number.NaN, true])
        assert.equal(isDue({ ...due, stored }), true, JSON.stringify(stored))
})

test('shown once the gate has opened the session, with nothing in the way and the mark kept', () => {
    assert.equal(firstVisitDue(facts()), 'show')
    assert.equal(firstVisitDue(facts({ phase: 'opening' })), 'skip')
    assert.equal(firstVisitDue(facts({ phase: 'error' })), 'skip')
    assert.equal(firstVisitDue(facts({ blocking: true })), 'skip')
    assert.equal(firstVisitDue(facts({ modalOpen: true })), 'skip')
    // Another tab showed it meanwhile.
    assert.equal(firstVisitDue(facts({ stored: FIRST_VISIT_REVISION })), 'skip')
})

test('a hidden page waits, and the mark is written only when it shows', () => {
    let writes = 0
    const keep = () => {
        writes++
        return true
    }
    assert.equal(firstVisitDue(facts({ visible: false, keep })), 'waitVisible')
    assert.equal(writes, 0)
    assert.equal(firstVisitDue(facts({ visible: true, keep })), 'show')
    assert.equal(writes, 1)
    // Skipped for another reason, it writes nothing.
    assert.equal(firstVisitDue(facts({ blocking: true, keep })), 'skip')
    assert.equal(writes, 1)
})

test('a mark that cannot be written or reads back otherwise skips it', () => {
    assert.equal(firstVisitDue(facts({ keep: () => false })), 'skip')
})

test('only Continued and the in-app browser line may sit under it', () => {
    const allowed = Object.entries(LOAD_ORDER)
        .filter(([, order]) => !blocking([order]))
        .map(([name]) => name)
    assert.deepEqual(allowed.sort(), ['continued', 'inAppBrowser'])
    assert.equal(blocking([]), false)
    assert.equal(blocking([LOAD_ORDER.continued, LOAD_ORDER.inAppBrowser]), false)
    assert.equal(blocking([LOAD_ORDER.continued, LOAD_ORDER.unsavedRecovered]), true)
})
