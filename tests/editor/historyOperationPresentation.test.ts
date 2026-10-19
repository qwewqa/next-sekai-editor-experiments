import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { eases } from '../../src/ease'
import {
    captureOperationRecipe,
    describeCapturedOperation,
    describeEntry,
    describeMember,
    describeOperation,
    describeStep,
    disambiguateOperationRecipes,
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
    { id: 'nse.object.edit', data: { subject: 'cameraEvent', targets: 1 } },
    { id: 'nse.object.move', data: { subject: 'timeScale', targets: 2 } },
    { id: 'nse.object.replace', data: { subject: 'bpm', targets: 1, displaced: { bpm: 1 } } },
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
            targets: 2,
            assignments: [{ field: 'isCritical', value: { mode: 'uniform', value: true } }],
        },
    },
    { id: 'nse.object.delete', data: { removed: { note: 3 } } },
    { id: 'nse.object.cut', data: { removed: { bpm: 1 } } },
    { id: 'nse.object.flip', data: { axis: 'horizontal', subject: 'note', targets: 2 } },
    {
        id: 'nse.object.scale',
        data: {
            axis: 'beats',
            subject: 'note',
            targets: 2,
            transform: { mode: 'uniform', factor: 1.0000000000000002, pivot: -0.0000001 },
        },
    },
    { id: 'nse.note.combine', data: { notes: 3 } },
    { id: 'nse.note.split', data: { points: 2 } },
    { id: 'nse.note.vertical', data: { targets: 2 } },
    {
        id: 'nse.property.set',
        data: {
            subject: 'note',
            targets: 2,
            assignments: [{ field: 'left', value: { mode: 'uniform', value: 0 } }],
        },
    },
    { id: 'nse.header.set', data: { field: 'bgmOffset', before: 0, after: 1.0000000000000002 } },
    {
        id: 'nse.bgm.change',
        data: { file: { before: captureName('same.ogg'), after: captureName('same.ogg') } },
    },
    { id: 'nse.dynamicStages.enable', data: {} },
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
    { id: 'nse.recovery', data: { source: 'journal', droppedSteps: 2 } },
    { id: 'nse.externalChange', data: {} },
] as const satisfies readonly NativeOperationInput[]

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
            assert.equal(details.stepCount, 1)
            assert.equal(details.explanation, undefined)
            assert(
                details.sections.every((section) =>
                    section.rows.every((row) => typeof row.value === 'string' && row.label.length),
                ),
            )
        }
    }
    assert.equal(describeOperation(fixture[0], en), 'Added 3 notes')
    assert.equal(describeOperation(fixture[7], en), 'Pasted 3 objects')
    assert.equal(describeOperation(fixture[16], en), 'Set Lane to 0 on 2 notes')
    assert.equal(describeOperation(fixture[18], en), 'Changed BGM File')
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
                        targets: 1,
                        assignments: [{ field, value: { mode: 'uniform', value: samples[field] } }],
                    },
                } as NativeOperationInput
                const details = detail(input, ctx)
                const row = details.sections.find(({ key }) => key === 'properties')?.rows[0]
                assert.equal(row?.label, operationFieldLabel(field, ctx))
                assert.equal(
                    row?.value,
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
    const offset = detail(fixture[17]).sections[0]
    assert.equal(offset?.rows[1]?.value, '1,000.0000000000002')
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
        assert.equal(details.explanation, ja.strings.history.details.unsupported)
        assert.deepEqual(details.sections, [])
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
        assert.deepEqual(
            detail(input).sections[0]?.rows.map(({ value }) => value),
            ['9,007,199,254,740,991', '9,007,199,254,740,991'],
        )
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
        data: { subject: 'bpm', targets: 0, displaced: { bpm: 1 }, retainedInitialBpm: true },
    } as const
    assert.equal(describeOperation(zero, en), 'Moved 0 BPM changes')
    assert(detail(zero).sections.some(({ key }) => key === 'retained'))
    assert.throws(() => recipe([zero, zero]), /Incompatible/)
})

test('uniform values, varying fields, broad brush/multifield families and axis-only transforms', () => {
    const set = (value: number): NativeOperationInput => ({
        id: 'nse.property.set',
        data: {
            subject: 'note',
            targets: 1,
            assignments: [{ field: 'left', value: { mode: 'uniform', value } }],
        },
    })
    assert.equal(renderOperationRecipe(recipe([set(0), set(0)]), en), 'Set Lane to 0 on notes')
    assert.equal(renderOperationRecipe(recipe([set(0), set(1)]), en), 'Changed Lane on notes')
    const a = {
        id: 'nse.object.brush',
        data: {
            subject: 'note',
            targets: 1,
            assignments: [{ field: 'left', value: { mode: 'uniform', value: 1 } }],
        },
    } as const
    const b = {
        id: 'nse.object.brush',
        data: {
            subject: 'note',
            targets: 1,
            assignments: [{ field: 'isFake', value: { mode: 'uniform', value: false } }],
        },
    } as const
    assert.equal(renderOperationRecipe(recipe([a, b]), en), 'Brushed notes')
    const multi = {
        id: 'nse.property.set',
        data: {
            subject: 'note',
            targets: 1,
            assignments: [
                { field: 'isFake', value: { mode: 'uniform', value: false } },
                { field: 'left', value: { mode: 'uniform', value: 1 } },
            ],
        },
    } as const
    assert.equal(
        renderOperationRecipe(
            recipe([multi, { id: 'nse.object.edit', data: { subject: 'note', targets: 1 } }]),
            en,
        ),
        'Edited notes',
    )
    assert.equal(
        renderOperationRecipe(
            recipe([
                fixture[11],
                { ...fixture[11], data: { ...fixture[11].data, subject: 'objects' } },
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
    assert.equal(
        composed.sections.find(({ key }) => key === 'scale')?.rows[0]?.value,
        'Multiple Adjustments',
    )
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
            assert(rendered.includes(`"${text}"`), `${locale} ${kind}: ${rendered}`)
            assert.equal(detail(input, ctx).sections[0]?.rows[0]?.value, text)
            const empty = { ...input, data: { ...input.data, target: owner(kind, 9, '') } }
            const literal = {
                ...input,
                data: { ...input.data, target: owner(kind, 9, ctx.strings.historyChanges.notSet) },
            }
            assert.notEqual(describeOperation(empty, ctx), describeOperation(literal, ctx))
            assert.equal(detail(empty, ctx).sections[0]?.rows[0]?.value, '')
            const long = {
                ...input,
                data: { ...input.data, target: owner(kind, 9, '😀'.repeat(257)) },
            }
            assert(describeOperation(long, ctx).includes('😀'.repeat(256) + '…"'))
            assert.equal(detail(long, ctx).sections[0]?.rows[0]?.nameShortened, true)
            const numeric = { ...input, data: { ...input.data, target: owner(kind, 9, '1') } }
            assert.notEqual(
                describeOperation(numeric, ctx),
                renderOperationRecipe(recipe([numeric], true), ctx),
            )
        }
})

test('same-name identities gain frozen qualifiers and rename groups use exact first/last names', () => {
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
    const qualified = disambiguateOperationRecipes([a, b], en)
    assert.equal(renderOperationRecipe(qualified[0]!, en), 'Renamed group "A" (#1)')
    assert.equal(renderOperationRecipe(qualified[1]!, en), 'Renamed group "A" (#2)')
    assert.equal(renderOperationRecipe(a, en), 'Renamed group "A"')
    const selected = qualified[0]!
    const before = JSON.stringify(selected)
    renderOperationRecipe(selected, context('fr'))
    disambiguateOperationRecipes([selected], context('ja'))
    assert.equal(JSON.stringify(selected), before)
    assert(
        Object.isFrozen(selected.members) &&
            Object.isFrozen(selected.group?.fields ?? selected.group),
    )
    const long = 'x'.repeat(257)
    const truncated = recipe([rename(1, long, 'B'), rename(1, 'B', long)])
    assert.match(renderOperationRecipe(truncated, en), / to /)
})

test('singleton named owners and uniform reference values qualify only colliding identities', () => {
    const inputs: NativeOperationInput[] = [
        ...fixture.filter(({ id }) => id.startsWith('nse.owner.')),
        {
            id: 'nse.owner.delete',
            data: { domain: 'group', removed: { group: 1 }, target: owner() },
        },
        {
            id: 'nse.owner.moveMany',
            data: { domain: 'group', targets: 2, destination: owner('groupFolder') },
        },
        {
            id: 'nse.property.set',
            data: {
                subject: 'note',
                targets: 1,
                assignments: [{ field: 'groupId', value: { mode: 'uniform', value: owner() } }],
            },
        },
    ]
    for (const input of inputs) {
        const other: NativeOperationInput = JSON.parse(
            JSON.stringify(input, (key, value: unknown) =>
                key === 'id' && typeof value === 'number' ? value + 10 : value,
            ),
        )
        const a = recipe([input])
        const b = recipe([other])
        for (const locale of locales) {
            const ctx = context(locale)
            const original = renderOperationRecipe(a, ctx)
            const [first, second] = disambiguateOperationRecipes([a, b], ctx)
            assert(first && second)
            if (JSON.stringify(input) === JSON.stringify(other)) continue
            assert.notEqual(
                renderOperationRecipe(first, ctx),
                renderOperationRecipe(second, ctx),
                input.id,
            )
            assert.equal(renderOperationRecipe(a, ctx), original)
            assert(Object.isFrozen(first.qualifiers))
        }
    }
    const property = inputs.at(-1)!
    const other: NativeOperationInput = JSON.parse(
        JSON.stringify(property).replace('"id":1', '"id":2'),
    )
    const [a, b] = disambiguateOperationRecipes(
        [recipe([property], true), recipe([other], true)],
        en,
    )
    assert(a && b)
    assert.notEqual(renderOperationRecipe(a, en), renderOperationRecipe(b, en))
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
        assert.equal(details.children.length, 0)
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
    assert.deepEqual(
        bgm.sections[0]?.rows.map(({ value }) => value),
        ['same.ogg', 'same.ogg'],
    )
    const clear = detail({
        id: 'nse.bgm.change',
        data: { file: { before: null, after: null }, offset: { before: 0, after: 0 } },
    })
    assert.equal(clear.description, 'Changed BGM')
    assert.equal(clear.sections.length, 2)
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
    assert.equal(undoDetails.children, undo.members)
    assert.equal(undoDetails.sections.length, 0)
    assert.equal(undoDetails.children[1]?.description.kind, 'restore')
    assert.equal(undoDetails.stepCount, 3)
    assert.match(renderOperationRecipe(undo, en), /^Undid 3 steps$/)
    assert.equal(
        describeMember(undoDetails.children[0]!, context('ja')),
        '3個のノーツを追加しました',
    )
})
