import assert from 'node:assert/strict'
import test from 'node:test'
import {
    heightOf,
    isCountedParent,
    presentRow,
    recipeOfRow,
} from '../../src/editor/history/rowPresentation'
import { buildRows, type Entry, type EntryRow } from '../../src/editor/history/rows'
import {
    captureOperationRecipe,
    operationDetails,
    renderOperationRecipe,
    stepLang,
    type OperationTextContext,
} from '../../src/history/operationPresentation'
import { captureOperation, type EntryDescription } from '../../src/history/operations'
import en from '../../src/i18n/en/index.json'
import fr from '../../src/i18n/fr/index.json'
import {
    editStep,
    futureFixtureOperation,
    nativeOperation,
    noteAdd,
    restoreStep,
} from '../helpers/historySteps'

const context: OperationTextContext = { locale: 'en', strings: en, now: 0 }
const french: OperationTextContext = { locale: 'fr', strings: fr, now: 0 }
const edit = (created: number): EntryDescription => ({
    kind: 'edit',
    step: editStep(noteAdd(created)),
})
const rows = (descriptions: EntryDescription[], more = false, kept = true) =>
    buildRows(
        descriptions.map((description, index): Entry => ({
            ...description,
            sessionId: 's',
            seq: descriptions.length - index,
            time: 0,
            kept,
        })),
        { filter: 'all', expanded: new Set(), damaged: new Set(), more, now: 0 },
    ).filter((row): row is EntryRow => row.type === 'entry')

test('Add12 sums actual creations while repeated moves make no unique-target claim', () => {
    const [added] = rows(Array.from({ length: 12 }, () => edit(1)))
    assert.deepEqual(presentRow(added!, context), {
        main: 'Added 12 notes',
        steps: '12 steps',
        full: 'Added 12 notes · 12 steps',
    })
    const move: EntryDescription = {
        kind: 'edit',
        step: editStep(
            nativeOperation(
                { id: 'nse.object.move', data: { subject: 'note', changed: { note: 3 } } },
                'stale',
            ),
        ),
    }
    const [moved] = rows([move, move])
    assert.deepEqual(presentRow(moved!, context), {
        main: en.history.summary.movedNotes,
        steps: '2 steps',
        full: `${en.history.summary.movedNotes} · 2 steps`,
    })
})

test('unknown fallback remains plain captured text and never groups', () => {
    const text = '<b>{1} ノーツ | $&</b>'
    const description: EntryDescription = {
        kind: 'edit',
        step: editStep(futureFixtureOperation('unknown', { future: 123 }, text)),
    }
    const result = rows([description, description])
    assert.equal(result.length, 2)
    assert.equal(presentRow(result[0]!, french).full, text)
    assert.equal(
        operationDetails(recipeOfRow(result[0]!), french).note,
        fr.history.details.unsupported,
    )
})

test('a foreign fallback row, group step and recovery line name their language', () => {
    const foreign = (locale: string) =>
        editStep(
            captureOperation({
                id: 'test.future.lang',
                version: 1,
                data: {},
                fallback: { text: '好', locale },
            }),
        )
    const [row] = rows([{ kind: 'edit', step: foreign('zht') }])
    // The app locale code zht names Traditional Chinese by its script; English text names none.
    assert.equal(presentRow(row!, context).lang, 'zh-Hant')
    assert.equal(presentRow(row!, { ...context, locale: 'zht' }).lang, undefined)
    const [native] = rows([edit(1)])
    assert.equal('lang' in presentRow(native!, context), false)
    const [own] = rows([
        { kind: 'edit', step: editStep(futureFixtureOperation('same', {}, 'Same')) },
    ])
    assert.equal(presentRow(own!, context).lang, undefined)
    // Undone steps in an undo parent: the step list carries each line's language, unprefixed.
    const [parent] = rows([
        { kind: 'undo', step: foreign('zhs') },
        { kind: 'undo', step: editStep(noteAdd(1)) },
    ])
    const steps = operationDetails(recipeOfRow(parent!), context).steps!
    assert.deepEqual(
        steps.members.map((member) => member.lang),
        ['zh-Hans', undefined],
    )
    // A prefixed line mixes the current language with the captured one, so it names none.
    const [single] = rows([{ kind: 'undo', step: foreign('zhs') }])
    assert.equal(presentRow(single!, context).lang, undefined)
    // The Step Details title of a single Undo or Redo mixes the languages too; an edit names one.
    for (const kind of ['undo', 'redo'] as const) {
        const [mixed] = rows([{ kind, step: foreign('zht') }])
        const title = operationDetails(recipeOfRow(mixed!), context)
        assert.match(title.description, /好/)
        assert.equal(title.descriptionLang, undefined)
    }
    assert.equal(operationDetails(recipeOfRow(row!), context).descriptionLang, 'zh-Hant')
    assert.equal(stepLang(foreign('zhs'), context), 'zh-Hans')
    assert.equal(stepLang(editStep(noteAdd(1)), context), undefined)
})

test('direction groups count crossed steps while children retain original Restore and unknown categories', () => {
    const restored = restoreStep(1)
    const unknown = editStep(futureFixtureOperation('future', {}, 'Foreign action'))
    for (const kind of ['undo', 'redo'] as const) {
        const [parent] = rows([
            { kind, step: restored },
            { kind, step: unknown },
        ])
        const recipe = recipeOfRow(parent!)
        assert.equal(
            presentRow(parent!, context).main,
            kind === 'undo' ? 'Undid 2 steps' : 'Redid 2 steps',
        )
        assert.equal(presentRow(parent!, context).steps, undefined)
        assert.equal(
            operationDetails(recipe, context).steps?.members[1]?.member.description.kind,
            kind,
        )
        const child = { ...parent!, child: true, members: [parent!.entry], partial: false }
        assert.match(
            presentRow(child, context).main,
            kind === 'undo' ? /^Undo · Restored/ : /^Redo · Restored/,
        )
    }
})

test('selected recipe stays frozen through page completion, storage replacement and locale changes', () => {
    const [partial] = rows([edit(2), edit(1)], true)
    const recipe = recipeOfRow(partial!)
    const identity = recipe.members
    assert.equal(presentRow(partial!, context, recipe).full, 'Added 3 notes · 2+ steps')
    const [loaded] = rows([edit(2), edit(1), edit(8)])
    assert.equal(presentRow(loaded!, context, recipe).full, 'Added 3 notes · 2+ steps')
    assert.notEqual(
        presentRow(loaded!, french, recipe).main,
        presentRow(loaded!, context, recipe).main,
    )
    assert.equal(recipe.members, identity)
    assert.deepEqual(
        recipe.members.map((member) => member.id),
        ['s:1', 's:2'],
    )
    assert.equal(recipe.partial, true)
    assert.ok(Object.isFrozen(recipe) && Object.isFrozen(recipe.members))
})

test('same-name distinct targets stay separate rows with identical titles and no identity', () => {
    const rename = (id: number): EntryDescription => ({
        kind: 'edit',
        step: editStep(
            nativeOperation(
                {
                    id: 'nse.owner.rename',
                    data: {
                        target: { kind: 'group', id, name: { text: 'After' } },
                        before: { text: 'Before' },
                        after: { text: 'After' },
                    },
                },
                'stale',
            ),
        ),
    })
    const parents = rows([rename(1), rename(2)])
    assert.equal(parents.length, 2)
    const titles = parents.map((row) => renderOperationRecipe(recipeOfRow(row), context))
    assert.equal(titles[0], titles[1])
    assert.doesNotMatch(titles[0]!, /#d/)
})

test('a partial singleton has truthful count but no synthesized child', () => {
    const [partial] = rows([edit(100)], true)
    assert.equal(isCountedParent(partial!), true)
    assert.equal(presentRow(partial!, context).full, 'Added 100 notes · 1+ steps')
    assert.equal(presentRow(rows([edit(100)])[0]!, context).full, 'Added 100 notes')
    const [undo] = rows([{ kind: 'undo', step: editStep(noteAdd(1)) }], true)
    assert.equal(presentRow(undo!, context).full, 'Undid 1+ steps')
})

test('all unavailable entries reserve the reason', () => {
    const [single] = rows([edit(1)], false, false)
    const [parent] = rows([edit(1), edit(1)], true, false)
    for (const row of [single!, parent!, { ...parent!, child: true }]) {
        assert.equal(heightOf(row), 80)
        assert.equal(heightOf({ ...row, selectable: true }), 44)
    }
    assert.equal(heightOf({ type: 'now', id: 'now' }), 44)
    assert.equal(heightOf({ type: 'gap', id: 'gap', count: 4 }), 44)
    assert.equal(heightOf({ type: 'header', id: 'h', level: 'day', withDay: false, time: 0 }), 28)
})

test('standalone unavailable recovery metadata retains its own ordered context once', () => {
    const head = editStep(futureFixtureOperation('head', {}, 'Source'))
    const tail = editStep(futureFixtureOperation('tail', {}, 'Redo tail'))
    const recipe = captureOperationRecipe([
        {
            description: {
                kind: 'recovered',
                operation: futureFixtureOperation('recovered', {}, 'Recovered'),
                recoveryContext: { head, headIndex: 0, dropped: [tail], omitted: 2 },
            },
            time: 1,
        },
    ])
    const details = operationDetails(recipe, context)
    assert.equal(details.recovery?.descriptions.length, 2)
    assert.equal(details.recovery?.headIndex, 0)
    assert.equal(details.recovery?.omitted, 2)
    assert.equal(details.steps, undefined)
})

const saved = (
    device: { id: string; label: string } | undefined,
    delivery: 'file' | 'download' = 'file',
) =>
    buildRows(
        [
            {
                kind: 'save',
                operation: nativeOperation(
                    { id: 'nse.file.save', data: { file: { text: 'coconut.nxsp' }, delivery } },
                    'Saved coconut.nxsp',
                ),
                sessionId: 's',
                seq: 1,
                time: 0,
                kept: true,
                ...(device ? { device } : {}),
            } as Entry,
        ],
        { filter: 'all', expanded: new Set(), damaged: new Set(), now: 0 },
    ).filter((row): row is EntryRow => row.type === 'entry')[0]!

test('a save from another device names it, and one from this browser does not', () => {
    const own = { id: 'mine', label: 'Web (Chrome)' }
    assert.equal(presentRow(saved(own), context, undefined, 'mine').main, 'Saved coconut.nxsp')
    assert.equal(
        presentRow(saved(undefined), context, undefined, 'mine').main,
        'Saved coconut.nxsp',
    )
    assert.equal(
        presentRow(saved({ id: 'ipad', label: 'iPad' }), context, undefined, 'mine').main,
        'Saved on iPad',
    )
    assert.equal(
        presentRow(saved({ id: 'other', label: 'Web (Firefox)' }), context, undefined, 'mine').main,
        'Saved in the web editor (Firefox)',
    )
    assert.equal(
        presentRow(saved({ id: 'other', label: 'Web' }), context, undefined, 'mine').main,
        'Saved in the web editor',
    )
    // A download keeps its own wording.
    assert.equal(
        presentRow(saved({ id: 'ipad', label: 'iPad' }, 'download'), context, undefined, 'mine')
            .main,
        'Downloaded coconut.nxsp',
    )
})
