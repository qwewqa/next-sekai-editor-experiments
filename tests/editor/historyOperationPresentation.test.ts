import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { hostZone } from '../../src/calendar/calendar'
import { eases } from '../../src/ease'
import {
    captureOperationRecipe,
    describeCapturedOperation,
    describeEntry,
    describeMember,
    describeOperation,
    describeStep,
    message,
    operationDetails,
    operationFieldLabel,
    operationStepCount,
    operationValueText,
    renderOperationRecipe,
    type OperationTextContext,
} from '../../src/history/operationPresentation'
import {
    captureEntryDescription,
    captureName,
    captureOperation,
    captureStep,
    createOperation,
    fieldCodecs,
    fieldSubjects,
    operationCodecs,
    type EntryDescription,
    type FieldId,
    type FieldValue,
    type NativeOperationInput,
    type OwnerKind,
    type StepDescription,
} from '../../src/history/operations'
import { formatPropertyNumber } from '../../src/utils/formatPropertyNumber'

const locales = ['en', 'fr', 'ja', 'ko', 'tr', 'zhs', 'zht'] as const
const context = (locale = 'en'): OperationTextContext => ({
    locale,
    strings: JSON.parse(
        readFileSync(new URL(`../../src/i18n/${locale}/index.json`, import.meta.url), 'utf8'),
    ),
    now: 1_700_000_000_000,
    zone: hostZone(),
})
const en = context()
const owner = <K extends OwnerKind = 'group'>(kind: K = 'group' as K, id = 1, text = 'A') => ({
    kind,
    id,
    name: captureName(text),
})
const captured = (input: NativeOperationInput, ctx = en) =>
    createOperation(input, {
        locale: ctx.locale,
        describe: (input) => describeOperation(input, ctx),
    })
const member = (input: NativeOperationInput, kind: StepDescription['kind'] = 'edit') => ({
    description: captureStep({ kind, operation: captured(input) }),
})
const recipe = (inputs: readonly NativeOperationInput[], partial = false) =>
    captureOperationRecipe(
        inputs.map((input) => member(input)),
        { partial },
    )
const detail = (input: NativeOperationInput, ctx = en) => operationDetails(recipe([input]), ctx)
const fixture = [
    { id: 'nse.note.add', data: { created: 3 } },
    { id: 'nse.note.generate', data: { created: 4 } },
    { id: 'nse.object.add', data: { subject: 'bpm', created: 2 } },
    { id: 'nse.object.edit', data: { subject: 'cameraEvent', changed: { cameraEvent: 1 } } },
    { id: 'nse.object.move', data: { subject: 'timeScale', changed: { timeScale: 2 } } },
    {
        id: 'nse.object.replace',
        data: { subject: 'bpm', changed: { bpm: 1 }, displaced: { bpm: 1 } },
    },
    { id: 'nse.note.elevation', data: { targets: 2 } },
    {
        id: 'nse.object.paste',
        data: {
            placed: { note: 2, timeScale: 1 },
            displaced: { timeScale: 1 },
            variant: 'composed',
            flipped: false,
            at: 'position',
        },
    },
    {
        id: 'nse.object.brush',
        data: {
            subject: 'note',
            changed: { note: 2 },
            assignments: [
                {
                    field: 'isCritical',
                    before: { mode: 'uniform', value: false },
                    after: { mode: 'uniform', value: true },
                },
            ],
        },
    },
    { id: 'nse.object.delete', data: { removed: { note: 3 } } },
    { id: 'nse.object.cut', data: { removed: { bpm: 1 } } },
    { id: 'nse.object.flip', data: { axis: 'horizontal', subject: 'note', changed: { note: 2 } } },
    {
        id: 'nse.object.scale',
        data: {
            axis: 'beats',
            subject: 'note',
            changed: { note: 2 },
            transform: { mode: 'uniform', factor: 1.0000000000000002, pivot: -0.0000001 },
        },
    },
    { id: 'nse.note.combine', data: { targets: 3 } },
    { id: 'nse.note.split', data: { targets: 2 } },
    { id: 'nse.note.vertical', data: { targets: 2 } },
    {
        id: 'nse.property.set',
        data: {
            subject: 'note',
            changed: { note: 2 },
            assignments: [
                {
                    field: 'left',
                    before: { mode: 'uniform', value: 1 },
                    after: { mode: 'uniform', value: 0 },
                },
            ],
        },
    },
    { id: 'nse.header.set', data: { field: 'bgmOffset', before: 0, after: 1.0000000000000002 } },
    {
        id: 'nse.bgm.change',
        data: { file: { before: captureName('same.ogg'), after: captureName('same.ogg') } },
    },
    {
        id: 'nse.dynamicStages.enable',
        data: { created: { stageMaskEvent: 1, stagePivotEvent: 1, stageStyleEvent: 1 } },
    },
    { id: 'nse.owner.create', data: { target: owner(), destination: null, gathered: 0 } },
    {
        id: 'nse.owner.rename',
        data: { target: owner(), before: captureName('Old'), after: captureName('New') },
    },
    {
        id: 'nse.owner.set',
        data: { target: owner(), changes: [{ field: 'forceNoteSpeed', before: null, after: 0 }] },
    },
    {
        id: 'nse.owner.move',
        data: {
            target: owner(),
            destination: owner('groupFolder', 4, 'Folder'),
            category: 'intoFolder',
            fromIndex: 1,
            toIndex: 0,
        },
    },
    { id: 'nse.owner.moveMany', data: { domain: 'stage', targets: 2, destination: null } },
    {
        id: 'nse.owner.duplicate',
        data: {
            domain: 'group',
            created: { group: 2, groupFolder: 1 },
            source: owner('groupFolder'),
        },
    },
    { id: 'nse.owner.delete', data: { domain: 'stage', removed: { stage: 2, stageFolder: 1 } } },
    { id: 'nse.owner.ungroup', data: { target: owner('groupFolder'), released: 2 } },
    { id: 'nse.origin', data: { origin: 'new' } },
    { id: 'nse.continue', data: { fromTime: 1_600_000_000_000 } },
    { id: 'nse.file.save', data: { file: captureName('chart.nxsp'), delivery: 'file' } },
    { id: 'nse.file.export', data: { file: captureName('chart.json'), delivery: 'download' } },
    { id: 'nse.restore', data: { targetTime: 1_600_000_000_000 } },
    { id: 'nse.recovery', data: { droppedSteps: 2 } },
    { id: 'nse.externalChange', data: {} },
    {
        id: 'nse.levelInfo.set',
        data: {
            changes: [
                { field: 'title', before: captureName(''), after: captureName('Coconut') },
                { field: 'artists', before: captureName('A'), after: captureName('B') },
                { field: 'rating', before: null, after: 12 },
                { field: 'tags', added: 2, removed: 1, changed: 1, reordered: true },
                { field: 'cover', before: null, after: captureName('cover.png') },
                { field: 'initialLife', before: 1000, after: 900 },
            ],
        },
    },
] as const satisfies readonly NativeOperationInput[]

/** Every string a Details record shows: labels, counts, both sides of a change, values and facts. */
const detailTexts = (details: ReturnType<typeof operationDetails>) => [
    ...details.rows.flatMap((row) =>
        row.kind === 'counts'
            ? [row.label, ...row.items]
            : row.kind === 'change'
              ? [row.label, row.before.text, row.after.text]
              : [row.label, row.value.text],
    ),
    ...details.facts,
]

test('all native IDs render current-language singleton descriptions and complete Details', () => {
    assert.deepEqual(fixture.map(({ id }) => id).sort(), Object.keys(operationCodecs).sort())
    for (const locale of locales) {
        const ctx = context(locale)
        for (const input of fixture) {
            const operation = captured(input, ctx)
            const text = describeOperation(input, ctx)
            assert.equal(operation.fallback.text, text)
            assert(text.length > 0, `${locale} ${input.id}`)
            assert(!/\{\d+\}/.test(text), `${locale} ${input.id}: ${text}`)
            assert.notEqual(text, ctx.strings.history.summary.edit)
            const details = detail(input, ctx)
            assert.equal(details.description, text)
            assert.equal(details.steps, undefined)
            assert.equal(details.note, undefined)
            assert(details.rows.every((row) => row.label.length && row.key.length))
            assert(details.rows.every((row) => row.kind !== 'counts' || row.items.length))
            for (const shown of [...detailTexts(details), text]) {
                assert(shown.length > 0, `${locale} ${input.id}: empty text`)
                assert(
                    !/\{\d+\}|undefined|NaN|\[object/.test(shown),
                    `${locale} ${input.id}: ${shown}`,
                )
            }
        }
    }
    assert.equal(describeOperation(fixture[0], en), 'Added 3 notes')
    assert.equal(describeOperation(fixture[7], en), 'Pasted 3 objects')
    assert.equal(describeOperation(fixture[16], en), 'Set Lane to 0 on 2 notes')
    assert.equal(describeOperation(fixture[18], en), 'Changed BGM file')
    assert.equal(describeOperation(fixture[22], en), 'Set Force Note Speed of "A" group to 0')
})

const samples: Record<FieldId, FieldValue<FieldId>> = {
    beat: 1,
    editorLane: 0,
    left: 0,
    size: 1,
    cameraLeft: 0,
    cameraSize: 1,
    maskLeft: 0,
    maskSize: 1,
    pivotLane: 0,
    xTranslation: 0,
    yTranslation: 0,
    bpm: 120,
    meter: 4,
    timeScale: 1,
    skip: 2,
    timeScaleEase: 'inQuad',
    timeScaleTransition: 'scroll',
    hideNotes: false,
    cameraZoom: 1,
    cameraZoomTargetLane: 0,
    cameraZoomTargetY: 0,
    cameraZoomVerticalAlign: 'center',
    cameraRotation: 0,
    cameraStageTilt: 0,
    isMaskNotes: true,
    divisionSize: 1,
    divisionParity: 'odd',
    yOffset: 0,
    yOffsetBeat: 0,
    judgmentLineColor: 'red',
    judgmentLineStyle: 'singleLine',
    leftBorderStyle: 'light',
    rightBorderStyle: 'disabled',
    isFullWidth: false,
    noteAlpha: 0,
    laneAlpha: 0,
    judgmentLineAlpha: 0,
    divisionLineAlpha: 0,
    rotation: 0,
    anchor: 'center',
    eventEase: 'outElastic',
    noteType: 'trace',
    isCritical: false,
    flickDirection: 'upLeft',
    isAttached: false,
    noteStyle: 'blue',
    isFake: false,
    sfx: 'criticalFlick',
    isConnectorSeparator: false,
    connectorType: 'guide',
    connectorStyle: 'purple',
    connectorEase: 'inOutStep',
    connectorIsFake: false,
    connectorActiveIsCritical: false,
    connectorGuideAlpha: 0,
    connectorLayer: 'under',
    connectorIsPassThrough: false,
    connectorPresentation: 'fullscreen',
    groupId: owner('group'),
    stageId: owner('stage'),
    elevation: 0,
}

test('all 61 fields retain their qualified labels, applicability, typed values and units', () => {
    assert.equal(Object.keys(samples).length, 61)
    assert.deepEqual(Object.keys(samples).sort(), Object.keys(fieldCodecs).sort())
    for (const locale of locales) {
        const ctx = context(locale)
        const labels: string[] = []
        for (const field of Object.keys(samples) as FieldId[]) {
            labels.push(operationFieldLabel(field, ctx))
            assert(fieldCodecs[field].is(samples[field]))
            for (const subject of fieldSubjects[field]) {
                const input = {
                    id: 'nse.property.set',
                    data: {
                        subject,
                        changed: { [subject]: 1 },
                        assignments: [
                            {
                                field,
                                before: { mode: 'varying' },
                                after: { mode: 'uniform', value: samples[field] },
                            },
                        ],
                    },
                } as NativeOperationInput
                const details = detail(input, ctx)
                const row = details.rows.find(({ key }) => key === field)
                assert.equal(row?.kind, 'change')
                assert.equal(row.label, operationFieldLabel(field, ctx))
                assert.deepEqual(row.before, {
                    text: ctx.strings.history.details.varying,
                    placeholder: true,
                })
                assert.equal(
                    row.after.text,
                    typeof samples[field] === 'object'
                        ? 'A'
                        : operationValueText(field, samples[field], ctx),
                )
            }
        }
        assert.equal(new Set(labels).size, labels.length, locale)
    }
    assert.equal(operationFieldLabel('skip', en), 'Skip (beats)')
    assert.equal(operationFieldLabel('yOffsetBeat', en), 'Y Offset (beats)')
    assert.equal(operationValueText('noteAlpha', 1.0000000000000002, en), '1.0000000000000002')
    assert.equal(operationValueText('isFake', false, en), 'Disabled')
    for (const ease of eases) assert(operationValueText('eventEase', ease, en).length)
    const offset = detail(fixture[17]).rows[0]
    assert.equal(offset?.kind === 'change' && offset.after.text, '1,000.0000000000002')
    assert.equal(formatPropertyNumber(-0.0000001, 'en', 3), '-0.0001')
})

test('known text relocalizes while unknown text and actual coarse kind remain literal', () => {
    const step = member(fixture[0]).description
    const ja = context('ja')
    assert.equal(describeStep(step, ja), '3個のノーツを追加しました')
    assert.equal((step.operation as { fallback: { text: string } }).fallback.text, 'Added 3 notes')
    for (const raw of [
        {
            id: 'future.unknown',
            version: 2,
            data: {},
            fallback: { text: '<b>{0}|$&</b>\n"name"', locale: 'xx' },
        },
        {
            ...captured(fixture[0]),
            extension: true,
            fallback: { text: 'future <b>text</b>', locale: 'fr' },
        },
    ]) {
        const op = captureOperation(raw)
        assert.equal(describeCapturedOperation(op, 'Save', ja), raw.fallback.text)
        const details = operationDetails(
            captureOperationRecipe([
                { description: captureStep({ kind: 'restore', operation: op }) },
            ]),
            ja,
        )
        assert.equal(details.description, raw.fallback.text)
        assert.equal(details.note, ja.strings.history.details.unsupported)
        assert.deepEqual(details.rows, [])
        assert.deepEqual(details.facts, [])
    }
    // A newer editor's step says so: an unknown nse id, or a known id with a newer version.
    for (const raw of [
        { id: 'nse.future.thing', version: 1, data: {}, fallback: { text: 'Later', locale: 'en' } },
        { id: 'nse.note.add', version: 2, data: {}, fallback: { text: 'Later', locale: 'en' } },
    ]) {
        const details = operationDetails(
            captureOperationRecipe([
                {
                    description: captureStep({
                        kind: 'edit',
                        operation: captureOperation(raw),
                    }),
                },
            ]),
            en,
        )
        assert.equal(details.note, en.strings.history.details.newer)
        assert.equal(details.description, 'Later')
    }
    // An empty fallback falls back to the kind label, and a foreign fallback names its language.
    const empty = captureOperation({
        id: 'future.x',
        version: 1,
        data: {},
        fallback: { text: '', locale: 'en' },
    })
    assert.equal(describeCapturedOperation(empty, 'Edit', en), 'Edit')
    const foreign = operationDetails(
        captureOperationRecipe([
            {
                description: captureStep({
                    kind: 'edit',
                    operation: captureOperation({
                        id: 'future.x',
                        version: 1,
                        data: {},
                        fallback: { text: 'Hola', locale: 'es' },
                    }),
                }),
            },
        ]),
        en,
    )
    assert.equal(foreign.descriptionLang, 'es')
    // An app locale code is not a language tag: Chinese is named by its script.
    for (const [locale, tag] of [
        ['zhs', 'zh-Hans'],
        ['zht', 'zh-Hant'],
    ] as const) {
        const chinese = operationDetails(
            captureOperationRecipe([
                {
                    description: captureStep({
                        kind: 'edit',
                        operation: captureOperation({
                            id: 'future.x',
                            version: 1,
                            data: {},
                            fallback: { text: '好', locale },
                        }),
                    }),
                },
            ]),
            en,
        )
        assert.equal(chinese.descriptionLang, tag)
    }
    for (const kind of ['init', 'edit', 'restore'] as const) {
        const malformed = captureStep({ kind, operation: { id: 'future' } })
        assert.equal(
            describeStep(malformed, en),
            { init: 'Initial state', edit: 'Edit', restore: 'Restore' }[kind],
        )
    }
    assert.equal(describeCapturedOperation(captureOperation({}), 'Save', en), 'Save')
})

test('creation/removal sums are truthful, overflowing totals preserve groups and mutations omit sums', () => {
    assert.equal(renderOperationRecipe(recipe([fixture[0], fixture[0]]), en), 'Added 6 notes')
    assert.equal(renderOperationRecipe(recipe([fixture[0]], true), en), 'Added 3 notes')
    assert.equal(renderOperationRecipe(recipe([fixture[9], fixture[9]]), en), 'Deleted 6 notes')
    assert.equal(
        renderOperationRecipe(recipe([fixture[3], fixture[3]]), en),
        'Edited camera events',
    )
    const max = Number.MAX_SAFE_INTEGER
    const huge = { id: 'nse.note.add', data: { created: max } } as const
    const overflow = recipe([huge, fixture[0]])
    assert.equal(overflow.kind, 'group')
    assert.equal(overflow.members.length, 2)
    assert.equal(renderOperationRecipe(overflow, en), 'Added notes')
    for (const id of ['nse.object.delete', 'nse.object.cut'] as const) {
        const input = { id, data: { removed: { note: max, bpm: max } } }
        assert.equal(
            describeOperation(input, en),
            id.endsWith('delete') ? 'Deleted objects' : 'Cut objects',
        )
        // No stored operation can carry a total that overflows: the codec refuses it.
        assert.equal(operationCodecs[id].is(input.data), false)
    }
    assert.equal(
        describeOperation(
            { ...fixture[7], data: { ...fixture[7].data, placed: { note: max, bpm: max } } },
            en,
        ),
        'Pasted objects',
    )
    const zero = {
        id: 'nse.object.move',
        data: { subject: 'bpm', changed: {}, displaced: { bpm: 1 }, retainedInitialBpm: true },
    } as const
    assert.equal(describeOperation(zero, en), 'Moved BPM changes')
    assert.deepEqual(detail(zero).facts, [en.strings.history.details.retainedInitialBpm])
    assert.throws(() => recipe([zero, zero]), /Incompatible/)
})

test('uniform values, varying fields, broad brush/multifield families and axis-only transforms', () => {
    const set = (value: number): NativeOperationInput => ({
        id: 'nse.property.set',
        data: {
            subject: 'note',
            changed: { note: 1 },
            assignments: [
                {
                    field: 'left',
                    before: { mode: 'uniform', value: 9 },
                    after: { mode: 'uniform', value },
                },
            ],
        },
    })
    assert.equal(renderOperationRecipe(recipe([set(0), set(0)]), en), 'Set Lane to 0 on notes')
    assert.equal(renderOperationRecipe(recipe([set(0), set(1)]), en), 'Changed Lane on notes')
    const a = {
        id: 'nse.object.brush',
        data: {
            subject: 'note',
            changed: { note: 1 },
            assignments: [
                {
                    field: 'left',
                    before: { mode: 'uniform', value: 1 },
                    after: { mode: 'uniform', value: 1 },
                },
            ],
        },
    } as const
    const b = {
        id: 'nse.object.brush',
        data: {
            subject: 'note',
            changed: { note: 1 },
            assignments: [
                {
                    field: 'isFake',
                    before: { mode: 'uniform', value: true },
                    after: { mode: 'uniform', value: false },
                },
            ],
        },
    } as const
    assert.equal(renderOperationRecipe(recipe([a, b]), en), 'Brushed notes')
    const multi = {
        id: 'nse.property.set',
        data: {
            subject: 'note',
            changed: { note: 1 },
            assignments: [
                {
                    field: 'isFake',
                    before: { mode: 'uniform', value: true },
                    after: { mode: 'uniform', value: false },
                },
                {
                    field: 'left',
                    before: { mode: 'uniform', value: 1 },
                    after: { mode: 'uniform', value: 1 },
                },
            ],
        },
    } as const
    assert.equal(
        renderOperationRecipe(
            recipe([
                multi,
                { id: 'nse.object.edit', data: { subject: 'note', changed: { note: 1 } } },
            ]),
            en,
        ),
        'Edited notes',
    )
    assert.equal(
        renderOperationRecipe(
            recipe([
                fixture[11],
                {
                    ...fixture[11],
                    data: {
                        ...fixture[11].data,
                        subject: 'objects',
                        changed: { note: 1, bpm: 1 },
                    },
                },
            ]),
            en,
        ),
        'Flipped objects horizontally',
    )
    assert.equal(
        renderOperationRecipe(
            recipe([
                fixture[12],
                {
                    ...fixture[12],
                    data: {
                        ...fixture[12].data,
                        subject: 'objects',
                        changed: { note: 1, bpm: 1 },
                        transform: { mode: 'composed' },
                    },
                },
            ]),
            en,
        ),
        'Scaled beats',
    )
    const composed = detail({
        ...fixture[12],
        data: { ...fixture[12].data, transform: { mode: 'composed' } },
    })
    const factor = composed.rows.find(({ key }) => key === 'factor')
    assert.equal(factor?.kind === 'value' && factor.value.text, 'Multiple Adjustments')
})

test('all owner kinds quote literal names once and distinguish numbers, placeholders and excerpts', () => {
    for (const locale of locales)
        for (const kind of ['group', 'stage', 'groupFolder', 'stageFolder'] as const) {
            const ctx = context(locale)
            const text = '12 {0}|$& "quoted"\nline'
            const input = {
                id: 'nse.owner.create',
                data: { target: owner(kind, 9, text), destination: null, gathered: 0 },
            } as const
            const rendered = describeOperation(input, ctx)
            const quote = (value: string) => message(ctx, ctx.strings.history.quoted, value)
            assert(rendered.includes(quote(text)), `${locale} ${kind}: ${rendered}`)
            assert.deepEqual(detail(input, ctx).rows, [])
            const empty = { ...input, data: { ...input.data, target: owner(kind, 9, '') } }
            const literal = {
                ...input,
                data: { ...input.data, target: owner(kind, 9, ctx.strings.historyChanges.notSet) },
            }
            assert.notEqual(describeOperation(empty, ctx), describeOperation(literal, ctx))
            assert(describeOperation(empty, ctx).includes(quote('')))
            const long = {
                ...input,
                data: { ...input.data, target: owner(kind, 9, '😀'.repeat(257)) },
            }
            assert(describeOperation(long, ctx).includes(quote('😀'.repeat(256) + '…')))
            assert.deepEqual(detail(long, ctx).facts, [ctx.strings.history.details.textShortened])
            const numeric = { ...input, data: { ...input.data, target: owner(kind, 9, '1') } }
            assert.notEqual(
                describeOperation(numeric, ctx),
                renderOperationRecipe(recipe([numeric], true), ctx),
            )
        }
})

test('rename groups use exact first/last names and identical titles carry no identity', () => {
    const rename = (id: number, before: string, after: string): NativeOperationInput => ({
        id: 'nse.owner.rename',
        data: {
            target: owner('group', id, after),
            before: captureName(before),
            after: captureName(after),
        },
    })
    const a = recipe([rename(1, 'A', 'B'), rename(1, 'B', 'A')])
    const b = recipe([rename(2, 'A', 'B'), rename(2, 'B', 'A')])
    assert.equal(renderOperationRecipe(a, en), 'Renamed group "A"')
    assert.equal(renderOperationRecipe(b, en), 'Renamed group "A"')
    assert(!('qualifiers' in a))
    assert(Object.isFrozen(a.members) && Object.isFrozen(a.group?.fields ?? a.group))
    const long = 'x'.repeat(257)
    const truncated = recipe([rename(1, long, 'B'), rename(1, 'B', long)])
    assert.match(renderOperationRecipe(truncated, en), / to /)
})

test('full Timeline carriers project every coarse kind while bare initial steps retain context', () => {
    const recoveryContext = {
        head: { kind: 'init' as const, operation: null },
        headIndex: 0,
        dropped: [],
        omitted: 0,
    }
    for (const operation of [
        null,
        { id: 'future', fallback: { locale: 'xx', text: '{0}|<literal>' } },
        { id: 'future', fallback: { locale: 'xx', text: 17 } },
    ]) {
        const edit = captureStep({ kind: 'edit', operation, recoveryContext })
        const restore = captureStep({ kind: 'restore', operation, recoveryContext })
        const descriptions: EntryDescription[] = [
            { kind: 'init', operation },
            { kind: 'continue', operation },
            { kind: 'save', operation },
            { kind: 'export', operation },
            { kind: 'recovered', operation, recoveryContext },
            { kind: 'edit', step: edit },
            { kind: 'restore', step: restore },
            { kind: 'undo', step: edit },
            { kind: 'redo', step: restore },
        ]
        for (const description of descriptions) {
            for (const snapshot of ['abc123', new Uint8Array([1, 2, 3])]) {
                const entry = {
                    ...description,
                    sessionId: 'session',
                    seq: 0,
                    time: 123,
                    kept: true,
                    noteCount: 2,
                    snapshot,
                    device: { id: 'device', name: 'Desktop' },
                    previous: { sessionId: 'old', seq: 3, snapshot: 'old-root' },
                }
                // Timeline recipeOfRow passes full entries through this member projection.
                const members = [entry].reverse().map((item) => ({
                    description: item,
                    id: `${item.sessionId}:${item.seq}`,
                    time: item.time,
                }))
                const selected = captureOperationRecipe(members)
                assert.deepEqual(
                    selected.members[0]?.description,
                    captureEntryDescription(description),
                )
                assert.equal(selected.members[0]?.id, 'session:0')
                assert.equal(selected.members[0]?.time, 123)
                assert(Object.isFrozen(selected.members[0]?.description))
                for (const locale of locales) {
                    const ctx = context(locale)
                    assert.equal(
                        renderOperationRecipe(selected, ctx),
                        describeEntry(description, ctx),
                    )
                    const details = operationDetails(selected, ctx)
                    assert.equal(
                        !!details.recovery,
                        description.kind === 'recovered' || !!description.step,
                    )
                }
                if (description.kind === 'init' && operation === null)
                    assert.equal(renderOperationRecipe(selected, en), 'Initial state')
            }
        }
        for (const kind of ['init', 'edit', 'restore'] as const) {
            for (const withContext of [false, true]) {
                const step = captureStep({
                    kind,
                    operation,
                    ...(withContext ? { recoveryContext } : {}),
                })
                const selected = captureOperationRecipe([{ description: step }])
                assert.deepEqual({ ...selected.members[0]?.description }, { ...step })
                assert.equal(!!operationDetails(selected, en).recovery, withContext)
                assert.equal(renderOperationRecipe(selected, en), describeStep(step, en))
            }
        }
    }
    assert.throws(() =>
        captureStep({ kind: 'init', operation: null, snapshot: new Uint8Array([1]) }),
    )
    assert.throws(() =>
        captureOperationRecipe([
            {
                description: {
                    kind: 'init',
                    operation: null,
                    recoveryContext: undefined,
                },
            },
        ]),
    )
})

test('actual recovered events retain one immutable ordered context without a pushed step', () => {
    const unknown = captureOperation({
        id: 'future.change',
        version: 9,
        fallback: { locale: 'en', text: '{0}|<opaque>' },
    })
    const head = captureStep({ kind: 'restore', operation: unknown })
    const same = member(fixture[0]).description
    const entry = captureEntryDescription({
        kind: 'recovered',
        operation: captured(fixture[33]),
        recoveryContext: { head, headIndex: 1, dropped: [same, same], omitted: 2 },
    })
    const selected = captureOperationRecipe([
        { description: entry, id: 'recovered-event', time: 123 },
    ])
    const snapshot = JSON.stringify(selected)
    for (const locale of locales) {
        const ctx = context(locale)
        const details = operationDetails(selected, ctx)
        assert.equal(details.description, ctx.strings.entry.recoveredChanges)
        assert.equal(details.recovery?.descriptions.length, 3)
        assert.deepEqual(details.recovery?.descriptions, [same, head, same])
        assert.equal(details.recovery?.headIndex, 1)
        assert.equal(details.recovery?.omitted, 2)
        assert.equal(details.steps, undefined)
        assert(Object.isFrozen(details.recovery?.descriptions))
        assert.equal(describeStep(details.recovery!.descriptions[1]!, ctx), '{0}|<opaque>')
    }
    assert.equal(JSON.stringify(selected), snapshot)
    assert.equal('step' in selected.members[0]!.description, false)
    assert.throws(() => captureOperationRecipe([{ description: entry }], { direction: 'undo' }))
    assert.throws(() => captureOperationRecipe([{ description: entry }, { description: entry }]))
    const crossed = captureStep({
        kind: 'edit',
        operation: captured(fixture[33]),
        recoveryContext: entry.kind === 'recovered' ? entry.recoveryContext : undefined,
    })
    const undone = captureEntryDescription({ kind: 'undo', step: crossed })
    const undoDetails = operationDetails(captureOperationRecipe([{ description: undone }]), en)
    assert.equal(undoDetails.description, 'Undo · Recovered changes')
    assert.deepEqual(undoDetails.recovery?.descriptions, [same, head, same])
    assert.equal(
        describeEntry(captureEntryDescription({ kind: 'save', operation: null }), en),
        'Save',
    )
    assert.equal(
        describeEntry(captureEntryDescription({ kind: 'export', operation: null }), en),
        en.strings.commands.exportLevel.title,
    )
    assert.equal(
        describeEntry(captureEntryDescription({ kind: 'continue', operation: unknown }), en),
        '{0}|<opaque>',
    )
    const partial = captureOperationRecipe([{ description: undone }], {
        direction: 'undo',
        partial: true,
    })
    assert.equal(renderOperationRecipe(partial, en), 'Undid 1+ steps')
    assert.equal(operationStepCount(partial, en), '1+ steps')
    assert.equal(operationStepCount(selected, en), '1 step')
})

test('Details keeps BGM same-name replacements, recovery insertion order and lazy crossed children', () => {
    const bgm = detail(fixture[18])
    assert.deepEqual(bgm.rows, [
        { kind: 'value', key: 'file', label: 'File', value: { text: 'same.ogg' } },
    ])
    const clear = detail({
        id: 'nse.bgm.change',
        data: { file: { before: null, after: null }, offset: { before: 0, after: 0 } },
    })
    assert.equal(clear.description, 'Changed BGM')
    assert.deepEqual(clear.rows, [
        {
            kind: 'value',
            key: 'file',
            label: 'File',
            value: { text: 'Not set', placeholder: true },
        },
    ])
    const before = member(fixture[0]).description
    const head = member(fixture[32], 'restore').description
    const after = member(fixture[22]).description
    const recovery = captureStep({
        ...member(fixture[33]).description,
        recoveryContext: { head, headIndex: 1, dropped: [before, after], omitted: 7 },
    })
    const details = operationDetails(captureOperationRecipe([{ description: recovery }]), en)
    assert.equal(details.recovery?.headIndex, 1)
    assert.deepEqual(
        details.recovery?.descriptions.map((step) => step.kind),
        ['edit', 'restore', 'edit'],
    )
    assert.equal(details.recovery?.omitted, 7)
    const undo = captureOperationRecipe(
        [{ description: before }, { description: head }, { description: after }],
        {
            direction: 'undo',
        },
    )
    const undoDetails = operationDetails(undo, context('ja'))
    const steps = undoDetails.steps!
    assert.deepEqual(
        steps.members.map(({ member }) => member),
        [...undo.members].reverse(),
    )
    assert.equal(undoDetails.rows.length, 0)
    assert.equal(steps.members[1]?.member.description.kind, 'restore')
    assert.equal(steps.count, 3)
    assert.equal(steps.prefixless, true)
    assert.match(renderOperationRecipe(undo, en), /^Undid 3 steps$/)
    assert.equal(steps.members[2]?.label, '3個のノーツを追加しました')
    assert.equal(
        describeMember(steps.members[2]!.member, context('ja')),
        '3個のノーツを追加しました',
    )
})

test('a BGM offset title is in milliseconds, the unit of the field', () => {
    const input = {
        id: 'nse.header.set',
        data: { field: 'bgmOffset', before: 0, after: 0.25 },
    } as const
    assert.equal(describeOperation(input, en), 'Set BGM Offset to 250 ms')
    assert.equal(
        describeOperation(
            { id: 'nse.header.set', data: { field: 'bgmOffset', before: 0, after: -1.5 } },
            en,
        ),
        'Set BGM Offset to -1,500 ms',
    )
    assert.equal(
        describeOperation(input, context('ja')),
        'BGMのオフセットを250ミリ秒に設定しました',
    )
    // Initial Life is not an offset and keeps its own scale.
    assert.equal(
        describeOperation(
            { id: 'nse.header.set', data: { field: 'initialLife', before: 1000, after: 900 } },
            en,
        ),
        'Set Initial Life to 900',
    )
})

test('a Level Info change cut to the same excerpt still shows its row', () => {
    const long = 'x'.repeat(300)
    const input = {
        id: 'nse.levelInfo.set',
        data: {
            changes: [
                {
                    field: 'description',
                    before: captureName(long + 'a'),
                    after: captureName(long + 'b'),
                },
            ],
        },
    } as const satisfies NativeOperationInput
    for (const locale of locales) {
        const details = detail(input, context(locale))
        assert.equal(details.rows.length, 1, locale)
        const row = details.rows[0]
        assert(row?.kind === 'change', locale)
        assert(row.before.shortened && row.after.shortened, locale)
        assert.equal(row.before.text, row.after.text)
    }
    // A cut name next to a different one is a change too, and an equal short name is not.
    const same = {
        id: 'nse.bgm.change',
        data: { file: { before: captureName('a.mp3'), after: captureName('a.mp3') } },
    } as const satisfies NativeOperationInput
    assert.equal(detail(same).rows[0]?.kind, 'value')
})

test('an empty file name never leaves a dangling space', () => {
    const empty = captureName('')
    for (const locale of locales) {
        const ctx = context(locale)
        const untitled = ctx.strings.save.placeholder
        for (const input of [
            { id: 'nse.file.save', data: { file: empty, delivery: 'file' } },
            { id: 'nse.file.save', data: { file: empty, delivery: 'download' } },
            { id: 'nse.file.export', data: { file: empty, delivery: 'download' } },
            { id: 'nse.origin', data: { origin: 'import', source: empty } },
        ] as const satisfies readonly NativeOperationInput[]) {
            const text = describeOperation(input, ctx)
            assert.equal(text, text.trim(), `${locale} ${input.id}: "${text}"`)
            assert(!/\s{2}/.test(text), `${locale} ${input.id}: "${text}"`)
            assert(text.includes(untitled), `${locale} ${input.id}: "${text}"`)
        }
        const exported = detail(
            { id: 'nse.file.export', data: { file: empty, delivery: 'download' } },
            ctx,
        )
        assert.equal(exported.facts.length, 1, locale)
        for (const fact of exported.facts) {
            assert.equal(fact, fact.trim(), `${locale}: "${fact}"`)
            assert(fact.includes(untitled), `${locale}: "${fact}"`)
        }
    }
})

// X-14: a Select drag that took an edge is a resize, titled and grouped as one, and never a move.
test('a resize is titled "Resized" in every locale, and groups with resizes and not with moves', () => {
    const resize = (count: number): NativeOperationInput => ({
        id: 'nse.object.move',
        data: { subject: 'note', changed: { note: count }, resized: true },
    })
    const move: NativeOperationInput = {
        id: 'nse.object.move',
        data: { subject: 'note', changed: { note: 2 } },
    }
    const camera: NativeOperationInput = {
        id: 'nse.object.move',
        data: { subject: 'cameraEvent', changed: { cameraEvent: 1 }, resized: true },
    }
    const moveCamera: NativeOperationInput = {
        id: 'nse.object.move',
        data: { subject: 'cameraEvent', changed: { cameraEvent: 1 } },
    }
    assert.equal(describeOperation(resize(1), en), 'Resized 1 note')
    assert.equal(describeOperation(resize(3), en), 'Resized 3 notes')
    assert.equal(describeOperation(move, en), 'Moved 2 notes')
    assert.equal(
        describeOperation(camera, en),
        `Resized 1 ${en.strings.eventKinds.cameraEvent} event`,
    )
    // Resizes group with resizes, quantity-free; a resize and a move are not one group.
    assert.equal(renderOperationRecipe(recipe([resize(1), resize(2)]), en), 'Resized notes')
    assert.equal(renderOperationRecipe(recipe([move, move]), en), 'Moved notes')
    assert.equal(
        renderOperationRecipe(recipe([camera, camera]), en),
        `Resized ${en.strings.eventKinds.cameraEvent} events`,
    )
    assert.throws(() => recipe([resize(1), move]), /Incompatible/)
    assert.throws(() => recipe([move, resize(1)]), /Incompatible/)
    // No locale titles a resize with its move wording.
    for (const locale of locales) {
        const ctx = context(locale)
        assert.notEqual(describeOperation(resize(2), ctx), describeOperation(move, ctx), locale)
        assert.notEqual(
            renderOperationRecipe(recipe([resize(2), resize(2)]), ctx),
            renderOperationRecipe(recipe([move, move]), ctx),
            locale,
        )
        assert.notEqual(describeOperation(camera, ctx), describeOperation(moveCamera, ctx), locale)
    }
})
