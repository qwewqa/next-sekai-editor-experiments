import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { aggregateValues, countOptions, valueRange } from '../../src/editor/utils/aggregate'
import {
    brushFields,
    brushGroups,
    fieldLabel,
    layoutFields,
    pickBrush,
    propertyField,
    propertyFields,
    propertySections,
    type PropertyField,
    type SelectionContext,
} from '../../src/editor/workspace/properties/fields'
import { summarizeSelection } from '../../src/editor/workspace/properties/summary'
import {
    isUnknownValue,
    isUnset,
    mixedOptions,
    mixedRange,
    mixedValues,
} from '../../src/modals/form/fieldUsage'
import type { Entity } from '../../src/state/entities'
import { formatNumber } from '../../src/utils/formatNumber'

type Row = { kind: string; a?: number; b?: string; hidden?: number }

const rows: Row[] = [
    { kind: 'x', a: 1, b: 'in', hidden: 5 },
    { kind: 'x', a: 3, b: 'in', hidden: 9 },
    { kind: 'y', a: -2, b: 'out' },
]

// `hidden` is unused by the second row, as a tail's connector is.
const appliesTo = (row: Row) => (key: string) => !(row === rows[1] && key === 'hidden')

test('aggregation keeps agreeing values and counts each value in use', () => {
    const { model, usage } = aggregateValues(rows, appliesTo)
    assert.equal(model.a, undefined)
    assert.equal(model.b, undefined)
    assert.equal(model.hidden, 5)
    assert.deepEqual(
        [...(usage.get('b')?.values ?? [])],
        [
            ['in', 2],
            ['out', 1],
        ],
    )
    assert.deepEqual(usage.get('hidden'), { values: new Map([[5, 1]]), covered: 1, total: 2 })
    assert.equal(usage.get('a')?.covered, 3)
    assert.equal(usage.get('a')?.total, 3)
})

test('ranges and option counts read the usage', () => {
    const { usage } = aggregateValues(rows, appliesTo)
    assert.deepEqual(valueRange(usage.get('a')), [-2, 3])
    assert.deepEqual(
        valueRange(usage.get('a'), (value) => value + 1),
        [-1, 4],
    )
    assert.equal(valueRange(usage.get('b')), undefined)
    assert.equal(valueRange(undefined), undefined)
    assert.deepEqual(countOptions(usage.get('b'), ['out', 'in', 'none']), [1, 2, 0])
    assert.deepEqual(
        countOptions(usage.get('b'), ['i', 'o'], (value, option) =>
            String(value).startsWith(option),
        ),
        [2, 1],
    )
})

const context = (values: Partial<SelectionContext>): SelectionContext => ({
    counts: {},
    noteFields: {},
    isDynamicStages: true,
    ...values,
})

const shown = (values: Partial<SelectionContext>) =>
    propertyFields.filter((field) => field.show(context(values))).map((field) => field.key)

test('a single note shows its fields grouped as before, elevation last', () => {
    const keys = shown({ counts: { note: 1 } })
    assert.deepEqual(keys.slice(0, 3), ['beat', 'left', 'size'])
    assert.equal(keys.at(-1), 'elevation')
    assert.ok(keys.includes('connectorEase'))
    assert.ok(keys.includes('stageId'))
})

test('fields hidden for every selected note stay hidden', () => {
    const keys = shown({ counts: { note: 1 }, noteFields: { connectorEase: false, left: false } })
    assert.ok(!keys.includes('connectorEase'))
    assert.ok(!keys.includes('left'))
    assert.ok(keys.includes('size'))
})

test('beat hides for several BPM or time scale changes', () => {
    assert.ok(shown({ counts: { bpm: 1, note: 2 } }).includes('beat'))
    assert.ok(shown({ counts: { bpm: 1, timeScale: 1 } }).includes('beat'))
    assert.ok(!shown({ counts: { bpm: 2, note: 2 } }).includes('beat'))
    assert.ok(!shown({ counts: { timeScale: 2 } }).includes('beat'))
})

test('stage fields need dynamic stages', () => {
    assert.ok(!shown({ counts: { note: 1 }, isDynamicStages: false }).includes('stageId'))
})

test('fields keep sections in order and each key appears once', () => {
    const keys = propertyFields.map((field) => field.key)
    assert.equal(new Set(keys).size, keys.length)
    const order = ['position', 'values', 'connector', 'organization', 'advanced']
    const sections = propertyFields.map((field) => order.indexOf(field.section))
    assert.deepEqual(
        sections,
        [...sections].sort((a, b) => a - b),
    )
})

test('the brush offers only properties it can apply', () => {
    const keys = brushFields.map((field) => field.key) as string[]
    for (const key of [
        'beat',
        'left',
        'editorLane',
        'bpm',
        'meter',
        'cameraLeft',
        'maskLeft',
        'pivotLane',
        'xTranslation',
    ])
        assert.ok(!keys.includes(key), key)
    assert.equal(keys.length, 56)
    assert.equal(propertyField.get('connectorEase')?.ease, true)
})

test('mixed fields name their values, ranges and counts', () => {
    const usage = {
        values: new Map<unknown, number>([
            [-4, 2],
            [0.1 + 0.2, 1],
            [6, 3],
        ]),
        covered: 6,
        total: 6,
    }
    assert.equal(mixedRange({ usage }), '-4 … 6')
    assert.equal(mixedRange({ usage, map: (value) => (value as number) + 1 }), '-3 … 7')
    assert.equal(formatNumber(0.1 + 0.2), '0.3')
    assert.equal(
        mixedRange({ usage: { values: new Map([[1, 4]]), covered: 4, total: 4 } }),
        undefined,
    )

    const toggles = {
        values: new Map<unknown, number>([
            [false, 1],
            [true, 3],
        ]),
        covered: 4,
        total: 4,
    }
    const narrowed: unknown[][] = []
    const values = mixedValues(
        {
            usage: toggles,
            narrow: (predicate) => narrowed.push([false, true].filter(predicate)),
        },
        (value) => `${value}`,
    )
    assert.deepEqual(
        values.map(({ label, count }) => [label, count]),
        [
            ['true', 3],
            ['false', 1],
        ],
    )
    values[0]?.narrow?.()
    assert.deepEqual(narrowed, [[true]])
    // Values a field cannot name are not listed.
    assert.deepEqual(
        mixedValues({ usage: toggles }, () => undefined),
        [],
    )

    const eases = {
        values: new Map<unknown, number>([
            ['inQuad', 2],
            ['outQuad', 1],
        ]),
        covered: 3,
        total: 3,
    }
    assert.deepEqual(
        mixedOptions(
            {
                usage: eases,
                matches: (value, option) => (value as string).startsWith(option as string),
            },
            [
                ['In', 'in'],
                ['Out', 'out'],
                ['In-Out', 'inOut'],
            ],
        ).map(({ label, count }) => [label, count]),
        [
            ['In', 2],
            ['Out', 1],
        ],
    )
})

test('the selection summary counts kinds in order and only slides of several notes', () => {
    const entities = [
        { type: 'bpm' },
        { type: 'note', slideId: 1 },
        { type: 'note', slideId: 1 },
        { type: 'note', slideId: 2 },
        { type: 'timeScale' },
        { type: 'note', slideId: 3 },
    ] as unknown as Entity[]
    const lengths = new Map([
        [1, 3],
        [2, 1],
        [3, 2],
    ])
    assert.deepEqual(
        summarizeSelection(entities, (slideId) => lengths.get(slideId) ?? 0),
        {
            kinds: [
                { kind: 'note', count: 4 },
                { kind: 'bpm', count: 1 },
                { kind: 'timeScale', count: 1 },
            ],
            slides: 2,
        },
    )
})

test('picking a brush keeps agreeing values and the agreeing half of eases', () => {
    const notes = [
        { noteType: 'default', size: 2, connectorEase: 'inQuad', beat: 1, cameraSize: 4 },
        { noteType: 'default', size: 3, connectorEase: 'inCubic', beat: 2, cameraSize: 4 },
    ]
    const aggregate = aggregateValues(notes, () => () => true)
    assert.deepEqual(pickBrush(aggregate, false), {
        noteType: 'default',
        connectorEase: 'type:in',
    })
    assert.deepEqual(pickBrush(aggregate, true), {
        noteType: 'default',
        connectorEase: 'type:in',
        cameraSize: 4,
    })
})

test('picking skips the stage without dynamic stages', () => {
    const aggregate = aggregateValues([{ stageId: 1, groupId: 2 }], () => () => true)
    assert.deepEqual(pickBrush(aggregate, false), { groupId: 2 })
    assert.deepEqual(pickBrush(aggregate, true), { groupId: 2, stageId: 1 })
})

test('unknown and unset values are told apart from mixed ones', () => {
    const options = [
        ['A', 'a'],
        ['B', 'b'],
    ] as const
    assert.equal(isUnknownValue('a', options), false)
    assert.equal(isUnknownValue(undefined, options), false)
    assert.equal(isUnknownValue('z', options), true)
    assert.equal(isUnset({ usage: { values: new Map(), covered: 2, total: 2 } }), true)
    assert.equal(isUnset({ usage: { values: new Map([[1, 2]]), covered: 2, total: 2 } }), false)
    assert.equal(isUnset(undefined), false)
})

test('unset optional values are not values in use', () => {
    const { model, usage } = aggregateValues(
        [{ meter: undefined }, { meter: 3 }, { meter: undefined }],
        () => () => true,
    )
    assert.equal(model.meter, 3)
    assert.deepEqual(usage.get('meter'), { values: new Map([[3, 1]]), covered: 3, total: 3 })
})

const locales = ['en', 'fr', 'ja', 'ko', 'tr', 'zhs', 'zht'] as const
type Messages = typeof import('../../src/i18n/en/index.json')
const messages = (locale: string) =>
    JSON.parse(
        readFileSync(new URL(`../../src/i18n/${locale}/index.json`, import.meta.url), 'utf8'),
    ) as Messages

const editableTypes = [
    'note',
    'bpm',
    'timeScale',
    'cameraEventJoint',
    'stageMaskEventJoint',
    'stagePivotEventJoint',
    'stageStyleEventJoint',
    'stageTransformEventJoint',
] as const

// Every name a field renders: its label, or an ease's type and function.
const renderedLabels = (field: PropertyField, t: Messages, qualified: boolean) => {
    if (!field.ease) return [fieldLabel(field, t, qualified)]
    const form = t.modals.form[field.key as 'timeScaleEase'] as {
        type: string
        function: string
        qualifiedType?: string
        qualifiedFunction?: string
    }
    return [
        (qualified && form.qualifiedType) || form.type,
        (qualified && form.qualifiedFunction) || form.function,
    ]
}

// Blocks of one kind, plus General, as Selection lays out the selection.
const blocksOf = (selection: SelectionContext) => {
    const kinds = editableTypes.filter((type) => selection.counts[type])
    return layoutFields(
        kinds,
        (kind) => ({ ...selection, counts: { [kind]: selection.counts[kind] } }),
        selection,
    ).map(({ kind, sections }) => ({
        kind,
        fields: propertySections.flatMap((section) => sections[section]),
    }))
}

for (const locale of locales) {
    test(`${locale} Selection labels stay unique within each block`, () => {
        const t = messages(locale)
        for (let mask = 1; mask < 1 << editableTypes.length; mask++) {
            const types = editableTypes.filter((_, index) => mask & (1 << index))
            for (const isDynamicStages of [true, false]) {
                for (const count of [1, 2]) {
                    const counts = Object.fromEntries(types.map((type) => [type, count]))
                    for (const { kind, fields } of blocksOf(context({ counts, isDynamicStages }))) {
                        // General names a field several kinds share by what it applies to.
                        const labels = fields.flatMap((field) =>
                            renderedLabels(field, t, !kind && field.key === 'eventEase'),
                        )
                        const repeated = labels.filter(
                            (label, index) => labels.indexOf(label) !== index,
                        )
                        assert.deepEqual(repeated, [], `${types.join('+')}`)
                    }
                }
            }
        }
    })

    test(`${locale} brush labels stay unique within each brush group and when removed`, () => {
        const t = messages(locale)
        for (const group of brushGroups) {
            const labels = brushFields
                .filter((field) => field.brush.group === group)
                .flatMap((field) => renderedLabels(field, t, false))
            assert.equal(new Set(labels).size, labels.length, group)
        }
        const removed = brushFields.map((field) => fieldLabel(field, t, true))
        assert.equal(new Set(removed).size, removed.length)
    })
}

test('fields of several kinds open the selection with General', () => {
    const keys = (selection: SelectionContext) =>
        blocksOf(selection).map(({ kind, fields }) => [kind, fields.map((field) => field.key)])
    // One kind keeps every field in one block.
    const notes = keys(context({ counts: { note: 3 } }))
    assert.equal(notes.length, 1)
    assert.ok((notes[0]![1] as string[]).includes('beat'))
    // Events each get their ease; General adds one for all of them, and Beat.
    const events = keys(context({ counts: { cameraEventJoint: 1, stageMaskEventJoint: 1 } }))
    assert.deepEqual(
        events.map(([kind]) => kind),
        [undefined, 'cameraEventJoint', 'stageMaskEventJoint'],
    )
    assert.ok((events[1]![1] as string[]).includes('eventEase'))
    assert.deepEqual(events[0]![1], ['beat', 'eventEase', 'stageId'])
    // Group, Stage and Elevation stay out of the kinds' blocks.
    const mixed = keys(context({ counts: { note: 2, timeScale: 1 } }))
    assert.ok(!(mixed[1]![1] as string[]).includes('groupId'))
    assert.deepEqual(mixed[0]![1], ['beat', 'groupId', 'stageId', 'elevation'])
    // Beat that General cannot take goes to each kind that can.
    const bpms = keys(context({ counts: { note: 2, bpm: 2 } }))
    assert.deepEqual(
        bpms.map(([kind, fields]) => [kind, (fields as string[]).includes('beat')]),
        [
            [undefined, false],
            ['note', true],
            ['bpm', false],
        ],
    )
    const t = messages('en')
    const ease = propertyField.get('timeScaleEase')!
    assert.equal(fieldLabel(ease, t, false), 'Ease')
    assert.equal(fieldLabel(ease, t, true), 'Time Scale Ease')
    // Fields without a short label read the same either way.
    const lane = propertyField.get('left')!
    assert.equal(fieldLabel(lane, t, true), fieldLabel(lane, t, false))
})

test("the tools' settings list their fields in the table's order", () => {
    const order = propertyFields.map((field) => field.key as string)
    for (const path of [
        'note/DefaultNotePropertiesFields.vue',
        'slide/DefaultSlidePropertiesFields.vue',
        'events/camera/DefaultCameraEventPropertiesFields.vue',
        'events/stage/mask/DefaultStageMaskEventPropertiesFields.vue',
        'events/stage/pivot/DefaultStagePivotEventPropertiesFields.vue',
        'events/stage/style/DefaultStageStyleEventPropertiesFields.vue',
        'events/stage/transform/DefaultStageTransformEventPropertiesFields.vue',
    ]) {
        const source = readFileSync(
            new URL(`../../src/editor/tools/${path}`, import.meta.url),
            'utf8',
        )
        const template = source.slice(source.indexOf('<template>'))
        const keys = [...template.matchAll(/<Optional(\w+)Field\b/g)].map(
            ([, name]) => name!.charAt(0).toLowerCase() + name!.slice(1),
        )
        for (const key of keys) assert.ok(order.includes(key), `${path}: ${key}`)
        assert.deepEqual(
            keys,
            [...keys].sort((a, b) => order.indexOf(a) - order.indexOf(b)),
            path,
        )
    }
})

test('a brushed time scale ease starts from None, which writes NONE', () => {
    assert.equal(propertyField.get('timeScaleEase')?.brush?.initial, 'none')
})

test('the rotation center fields follow Rotation, with qualified names for History and Brush', () => {
    const keys = shown({ counts: { stageTransformEventJoint: 1 } })
    const at = keys.indexOf('rotation')
    assert.deepEqual(keys.slice(at, at + 5), [
        'rotation',
        'rotationCenter',
        'centerXOffset',
        'centerYOffset',
        'anchor',
    ])
    const t = messages('en')
    const label = (key: string, qualified: boolean) =>
        fieldLabel(propertyField.get(key as never)!, t, qualified)
    assert.equal(label('rotationCenter', true), 'Rotation Center')
    assert.equal(label('centerXOffset', false), 'Center X Offset')
    assert.equal(label('centerXOffset', true), 'Rotation Center X Offset')
    assert.equal(label('centerYOffset', true), 'Rotation Center Y Offset')
    assert.equal(propertyField.get('rotationCenter')?.brush?.initial, 'stage')
})

test('qualified names drop a unit, unless only it tells two fields apart', () => {
    const qualified = (key: string, locale = 'en') =>
        fieldLabel(propertyField.get(key as never)!, messages(locale), true)
    assert.equal(qualified('skip'), 'Skip')
    assert.equal(qualified('yOffsetBeat'), 'Y Offset (beats)')
    assert.equal(qualified('leftBorderStyle'), 'Border Style (Left)')
    for (const locale of locales) assert.doesNotMatch(qualified('skip', locale), /[(（]/, locale)
})

type Description = string | { intro?: string; choices?: Record<string, string> }
const descriptions = () =>
    messages('en').modals.form.descriptions as unknown as Record<string, Description | undefined>

// Their labels and choices say enough.
const undescribed = [
    'name',
    'beat',
    'groupId',
    'stageId',
    'left',
    'size',
    'isCritical',
    'flickDirection',
    'connectorActiveIsCritical',
    'bpm',
    'editorLane',
    'cameraZoom',
    'laneColor',
    'judgmentLineColor',
    'judgmentLineStyle',
    'preset',
]
// Both border sides show the styles' lines.
const sharedDescription: Record<string, string> = {
    leftBorderStyle: 'borderStyle',
    rightBorderStyle: 'borderStyle',
}

test('the listed chart properties have an English description, and the others have no key', () => {
    const all = descriptions()
    const keys = [
        ...propertyFields.map((field) => field.key),
        // Group Properties, Stage Properties and Level Info.
        'name',
        'forceNoteSpeed',
        'isFromStart',
        'isUntilEnd',
        'generateSimLines',
        'initialLife',
        // The tool options among the properties.
        'copyProperties',
        'copyPropertiesSlide',
        'preset',
    ]
    for (const key of keys) {
        if (undescribed.includes(key)) {
            assert.equal(all[key], undefined, key)
            continue
        }
        const description = all[sharedDescription[key] ?? key]
        const texts =
            typeof description === 'string'
                ? [description]
                : [description?.intro, ...Object.values(description?.choices ?? {})]
        assert.ok(
            texts.some((text) => text?.trim()),
            key,
        )
    }
})

test('each choice description has a line for every option of its select, and no others', () => {
    const t = messages('en')
    const form = t.modals.form as unknown as Record<string, Record<string, string>>
    // A select names each option after its value, as noteType.forceTick names 'forceTick'.
    const named = (section: string) =>
        Object.keys(form[section]!).filter((key) => !['label', 'qualified'].includes(key))
    const options: Record<string, string[]> = {
        noteType: named('noteType'),
        connectorType: named('connectorType'),
        connectorPresentation: named('connectorPresentation'),
        cameraZoomVerticalAlign: named('cameraZoomVerticalAlign'),
        connectorLayer: named('connectorLayer'),
        timeScaleTransition: named('timeScaleTransition'),
        divisionParity: named('divisionParity'),
        borderStyle: named('borderStyle'),
        rotationCenter: named('rotationCenter'),
        anchor: named('anchor'),
        generateSimLines: named('generateSimLines'),
    }
    const withChoices = Object.entries(descriptions()).flatMap(([key, description]) =>
        typeof description === 'object' && description.choices
            ? [[key, description.choices] as const]
            : [],
    )
    assert.deepEqual(withChoices.map(([key]) => key).sort(), Object.keys(options).sort())
    for (const [key, choices] of withChoices) {
        assert.deepEqual(Object.keys(choices).sort(), [...options[key]!].sort(), key)
        for (const [value, text] of Object.entries(choices))
            assert.ok(text.trim(), `${key}.${value}`)
    }
})
