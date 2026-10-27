import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
    refusalLine,
    reportLines,
    type CheckText,
    type Findings,
} from '../../src/editor/check/report'

// The lines Check File and History ends with.

const en = JSON.parse(
    readFileSync(new URL('../../src/i18n/en/index.json', import.meta.url), 'utf8'),
) as {
    check: CheckText['check']
    open: { media: CheckText['media'] }
    load: { sessionLater: string }
    save: { readFailed: string }
}

const strings = (): CheckText => ({
    check: en.check,
    media: en.open.media,
    refusal: { later: en.load.sessionLater, unreadable: en.save.readFailed },
})

const text = (found: Findings) => reportLines(found, strings).map((line) => line())

test('nothing found: "No damage found." first, then the scope', () => {
    assert.deepEqual(text({ file: { name: 'coconut.nxsp' }, repaired: 0, damaged: 0, media: [] }), [
        'No damage found.',
        'Checked "coconut.nxsp" and the history stored in this browser.',
    ])
})

test('anything found never reads "No damage found."', () => {
    for (const found of [
        { fileDamaged: { name: 'a.nxsp' }, repaired: 0, damaged: 0, media: [] },
        { repaired: 1, damaged: 0, media: [] },
        { repaired: 0, damaged: 2, media: [] },
        // Repaired media still count: the damage was there.
        { repaired: 0, damaged: 0, media: [['cover'] as const] },
    ])
        assert.ok(!text(found).includes('No damage found.'))
})

test('the lines keep their order, with plural counts and each media kind once', () => {
    const lines = text({
        file: { name: 'coconut.nxsp' },
        fileDamaged: { name: 'coconut.nxsp' },
        repaired: 1,
        damaged: 3,
        // The same row used as the BGM and the preview, and a cover twice.
        media: [['preview', 'bgm'], ['cover'], ['cover']],
    })
    assert.deepEqual(lines, [
        '“coconut.nxsp” is damaged. Saving will create a separate file.',
        'Repaired 1 Timeline step.',
        '3 Timeline steps stored in this browser are damaged.',
        'The BGM stored in this browser was damaged.',
        'The cover stored in this browser was damaged.',
        'The preview audio stored in this browser was damaged.',
        'Checked "coconut.nxsp" and the history stored in this browser.',
    ])
})

test('a history-only check says so, and a reason line follows the scope', () => {
    const lines = text({
        reason: () => '“coconut.nxsp” has changed on disk since you opened or saved it here.',
        repaired: 2,
        damaged: 1,
        media: [],
    })
    assert.deepEqual(lines, [
        'Repaired 2 Timeline steps.',
        '1 Timeline step stored in this browser is damaged.',
        'Checked the history stored in this browser.',
        '“coconut.nxsp” has changed on disk since you opened or saved it here.',
    ])
})

test('a chain this build cannot judge says so, never that storage is unavailable', () => {
    assert.equal(
        refusalLine('needsNewer', 'coconut.nxsp', strings)(),
        'This session requires a newer version of the editor.',
    )
    for (const reason of ['unreadableHead', 'order'] as const)
        assert.equal(
            refusalLine(reason, 'coconut.nxsp', strings)(),
            '"coconut.nxsp" could not be read.',
        )
})
