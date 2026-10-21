import assert from 'node:assert/strict'
import test from 'node:test'
import { defineModelTests, Run } from './sessionModel'

// The model test of design A with the page's default journal writer (Chromium, Firefox 126 and
// later, Safari where it honours `durability`): a power loss is `loseRelaxed`. The Firefox-before-126
// runs are in `sessionModel.fx.test.ts`, so the two run side by side.
defineModelTests(false)

test('a pin excuses a line only for the operation and session that cause it', () => {
    const run = new Run(1, false)
    const lock =
        'lock: rows 3 of session id-9 were created while the page did not hold nse-session:id-9 exclusively'
    // Nothing recognised yet: a lock breach is no known breach.
    assert.equal(run.matchPin(lock, 'edit'), undefined)
    run.recognised.add('id-9')
    assert.equal(run.matchPin(lock, 'edit')?.id, 'AR-1 lock')
    // Another session's breach stays unexcused, as does a rule no pin names.
    assert.equal(run.matchPin(lock.replaceAll('id-9', 'id-10'), 'edit'), undefined)
    assert.equal(run.matchPin('session id-9: rows 2 are neither stored', 'edit'), undefined)
    // The AR-7 time pin is by its text alone; a content mismatch is not it.
    assert.equal(run.matchPin('I-11 (time): the cut of rev-1 carries', 'save')?.id, 'AR-7 time')
    assert.equal(run.matchPin('I-11 (content): the cut of rev-1 carries', 'save'), undefined)
})
