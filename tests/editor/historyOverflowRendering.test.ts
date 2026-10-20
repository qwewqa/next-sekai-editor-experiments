import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
    captureOperationRecipe,
    describeOperation,
    describeStep,
    operationDetails,
    type OperationTextContext,
} from '../../src/history/operationPresentation'
import {
    captureOperation,
    captureStep,
    createOperation,
    decodeOperation,
    type NativeOperationInput,
} from '../../src/history/operations'

// Counts whose total passes Number.MAX_SAFE_INTEGER cannot be stored: the codec refuses them, so
// `createOperation` throws before `pushState` and a stored step that carries one reads back as
// unsupported. The presentation's own overflow handling is therefore reachable only by casting,
// and the Step Details rows for it cannot be built from any step the editor can hold. What can be
// exercised is that both doors stay shut and that what comes through them still reads.

const en: OperationTextContext = {
    locale: 'en',
    strings: JSON.parse(
        readFileSync(new URL('../../src/i18n/en/index.json', import.meta.url), 'utf8'),
    ),
    now: 1_700_000_000_000,
}
const max = Number.MAX_SAFE_INTEGER

for (const id of ['nse.object.delete', 'nse.object.cut'] as const) {
    const data = { removed: { note: max, bpm: max } }
    const text = id.endsWith('delete') ? 'Deleted objects' : 'Cut objects'

    test(`${id}: an overflowing total is refused when the operation is made`, () => {
        assert.throws(() =>
            createOperation({ id, data } as unknown as NativeOperationInput, {
                locale: 'en',
                describe: (input) => describeOperation(input, en),
            }),
        )
    })

    test(`${id}: a stored overflowing total is unsupported, and its step still reads`, () => {
        const raw = captureOperation({
            id,
            version: 1,
            data,
            fallback: { text, locale: 'en' },
        })
        const decoded = decodeOperation(raw)
        assert.equal(decoded.status, 'unsupported')
        const step = captureStep({ kind: 'edit', operation: raw })
        assert.equal(describeStep(step, en), text)
        const details = operationDetails(captureOperationRecipe([{ description: step }]), en)
        assert.equal(details.description, text)
        assert.equal(details.note, en.strings.history.details.unsupported)
        assert.deepEqual(details.rows, [])
        assert.deepEqual(details.facts, [])
    })

    test(`${id}: describing the cast input does not throw and drops the total`, () => {
        assert.equal(describeOperation({ id, data } as unknown as NativeOperationInput, en), text)
    })
}
