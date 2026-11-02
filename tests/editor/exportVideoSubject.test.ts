import assert from 'node:assert/strict'
import test from 'node:test'
import { exportSubject } from '../../src/editor/exportVideo/subject'
import { createSessionDescriptor } from '../../src/history/session'
import type { State } from '../../src/state'

const state = { levelInfo: { title: 'Open Title' }, bgm: { offset: 0 } } as unknown as State

test('a live export is named after the open session and remembered under its chain', () => {
    const open = createSessionDescriptor({ name: 'Coconut', docId: 'doc-open' })
    assert.deepEqual(exportSubject(open, state), { stem: 'Coconut', chain: 'doc-open' })
})

test('with no name, the open chart is named by its title', () => {
    const open = createSessionDescriptor({ docId: 'doc-open' })
    assert.deepEqual(exportSubject(open, state), { stem: 'Open Title', chain: 'doc-open' })
})

test('a peeked session names the export and is not remembered under the open chain', () => {
    const open = createSessionDescriptor({ name: 'Coconut', docId: 'doc-open' })
    assert.deepEqual(exportSubject(open, state, { name: 'Re:Zero' }), { stem: 'Re.Zero' })
})
