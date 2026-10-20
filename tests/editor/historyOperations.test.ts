import assert from 'node:assert/strict'
import test from 'node:test'
import {
    captureJson,
    captureName,
    captureOperation,
    captureRecoveryContext,
    captureStep,
    checkedSum,
    createOperation,
    createRecoveryContext,
    decodeOperation,
    equalJson,
    fieldApplies,
    fieldCodecs,
    jsonBytes,
    OPERATION_NATIVE_BYTES,
    OPERATION_WIRE_BYTES,
    operationGroup,
    RECOVERY_CONTEXT_BYTES,
    recoverySources,
    stripUnknownEntryKeys,
    stripUnknownStepKeys,
    type JsonValue,
    type NativeOperationInput,
    type StepDescription,
} from '../../src/history/operations'
import {
    captureEntryDescription,
    entryOperation,
    pushedStep,
} from '../../src/history/operations/entries'

const options = { locale: 'en', describe: (input: NativeOperationInput) => input.id }
const make = (input: NativeOperationInput) => createOperation(input, options)
const wire = (id: string, data: unknown, version = 1) =>
    captureOperation({
        id,
        version,
        data,
        fallback: { text: 'Future operation <b>{0}</b>', locale: 'fr' },
    })
const step = (index: number): StepDescription =>
    captureStep({ kind: 'edit', operation: wire('future.action', { index }) })
const operationOf = (input: NativeOperationInput): JsonValue => captureOperation(make(input))

test('native operations capture before formatting and retain immutable values after caller changes', () => {
    const input = { id: 'nse.note.add', data: { created: 12 } } as const
    let calls = 0
    const result = createOperation(input, {
        locale: 'ja',
        describe: (operation, locale) => {
            calls++
            assert.equal(locale, 'ja')
            assert(Object.isFrozen(operation.data))
            return '12 notes'
        },
    })
    assert.equal(calls, 1)
    assert(Object.isFrozen(result))
    assert(Object.isFrozen(result.fallback))
    assert.notEqual(result.data, input.data)
    assert.equal(decodeOperation(captureOperation(result)).status, 'known')
    assert.throws(() => {
        ;(result.data as { created: number }).created = 99
    })
    assert.equal(result.fallback.text, '12 notes')
})

test('future IDs, versions, fields and enums retain the full original raw JSON', () => {
    const examples = [
        wire('future.quantize', { strength: 0.75, exactId: '9007199254740993' }),
        wire('nse.note.add', { created: 12 }, 2),
        wire('nse.note.add', { created: 12, future: { keep: ['all', 1] } }),
        wire('nse.object.move', { subject: 'futureEvent', targets: 1 }),
        wire('nse.property.set', {
            subject: 'note',
            changed: { note: 1 },
            assignments: [
                {
                    field: 'flickDirection',
                    before: { mode: 'uniform', value: 'none' },
                    after: { mode: 'uniform', value: 'futureDirection' },
                },
            ],
        }),
        captureOperation({
            id: 'nse.note.add',
            version: 1,
            data: { created: 1 },
            fallback: { text: 'Added', locale: 'en' },
            extension: { preserved: true },
        }),
    ]
    for (const raw of examples) {
        const result = decodeOperation(raw)
        assert.equal(result.status, 'unsupported')
        assert.equal(result.raw, raw)
        assert(equalJson(captureOperation(JSON.parse(JSON.stringify(raw))), raw))
        if (result.status === 'unsupported') assert(result.fallback?.text)
    }
    for (const raw of [null, 2, [], { nonsense: true }]) {
        const captured = captureOperation(raw)
        const result = decodeOperation(captured)
        assert.equal(result.status, 'unsupported')
        assert.equal(result.raw, captured)
    }
})

test('opaque own keys survive without prototype setters or accessor execution', () => {
    const source = JSON.parse(
        '{"__proto__":{"polluted":true},"constructor":{"prototype":3},"nested":{"toString":"literal"}}',
    ) as unknown
    const captured = captureOperation(source)
    assert.equal(Object.getPrototypeOf(captured), null)
    assert.equal(JSON.stringify(captured), JSON.stringify(source))
    assert.equal(({} as Record<string, unknown>).polluted, undefined)
    let accessed = 0
    const accessor = Object.defineProperty({}, 'data', {
        enumerable: true,
        get() {
            accessed++
            return 1
        },
    })
    assert.throws(() => captureOperation(accessor), /enumerable data/)
    assert.equal(accessed, 0)
    for (const bad of [
        new Date(),
        new Map(),
        { value: undefined },
        { value: Infinity },
        { value: 1n },
        { [Symbol('x')]: 1 },
        Object.defineProperty({}, 'hidden', { value: 1 }),
        new Array(2),
    ])
        assert.throws(() => captureOperation(bad))
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    assert.throws(() => captureOperation(cyclic), /cyclic/)
})

test('wire byte/depth limits are distinct from known native decoding limits', () => {
    const oversizedKnown = captureOperation({
        id: 'nse.note.add',
        version: 1,
        data: { created: 1 },
        fallback: { text: 'x'.repeat(OPERATION_NATIVE_BYTES), locale: 'en' },
    })
    assert.equal(decodeOperation(oversizedKnown).status, 'unsupported')
    assert(equalJson(oversizedKnown, captureOperation(JSON.parse(JSON.stringify(oversizedKnown)))))
    assert.equal(jsonBytes(captureJson('x'.repeat(OPERATION_WIRE_BYTES - 2))), OPERATION_WIRE_BYTES)
    assert.throws(() => captureJson('x'.repeat(OPERATION_WIRE_BYTES - 1)), /byte limit/)
    assert.throws(() => captureJson('😀'.repeat(OPERATION_WIRE_BYTES / 4)), /byte limit/)
    let nested: unknown = 1
    for (let i = 0; i < 16; i++) nested = { child: nested }
    captureOperation(nested)
    assert.throws(() => captureOperation({ child: nested }), /depth limit/)
})

test('native excerpts normalize lone surrogates and never split supplementary code points', () => {
    assert.deepEqual(captureName('A\ud800B'), { text: 'A�B' })
    const name = captureName('😀'.repeat(257))
    assert.equal([...name.text].length, 256)
    assert.equal(name.truncated, true)
    const operation = createOperation(
        { id: 'nse.note.add', data: { created: 1 } },
        {
            locale: 'en',
            describe: () => 'a'.repeat(1023) + '😀' + 'z',
        },
    )
    assert.equal(operation.fallback.text, 'a'.repeat(1023) + '…')
    const normalized = createOperation(
        { id: 'nse.note.add', data: { created: 1 } },
        {
            locale: 'en',
            describe: () => 'A\ud800B',
        },
    )
    assert.equal(normalized.fallback.text, 'A�B')
    assert.throws(() => captureOperation({ raw: '\ud800' }), /well formed/)
    assert.equal(captureName('x'.repeat(1_000_000)).text.length, 256)
})

test('counts and IDs use safe integers while scalar parameters retain finite binary64 values', () => {
    for (const created of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
        assert.throws(() => make({ id: 'nse.note.add', data: { created } }))
    }
    const operation = make({
        id: 'nse.header.set',
        data: { field: 'bgmOffset', before: 1e-30, after: 1e30 },
    })
    assert.equal(decodeOperation(captureOperation(operation)).status, 'known')
    assert.equal(checkedSum([Number.MAX_SAFE_INTEGER, 0]), Number.MAX_SAFE_INTEGER)
    assert.equal(checkedSum([Number.MAX_SAFE_INTEGER, 1]), undefined)
    assert.equal(checkedSum([1, -1]), undefined)
    assert.equal(operationGroup(make({ id: 'nse.note.add', data: { created: 0 } })), undefined)
})

test('properties accept effective values only for applicable native subjects', () => {
    assert.equal(Object.keys(fieldCodecs).length, 61)
    assert(fieldApplies('groupId', 'note'))
    assert(fieldApplies('groupId', 'timeScale'))
    assert(!fieldApplies('groupId', 'cameraEvent'))
    assert(fieldApplies('eventEase', 'stagePivotEvent'))
    assert(!fieldApplies('eventEase', 'note'))
    const left = {
        field: 'flickDirection',
        before: { mode: 'uniform', value: 'none' },
        after: { mode: 'uniform', value: 'upLeft' },
    } as const
    assert.equal(
        decodeOperation(
            wire('nse.property.set', {
                subject: 'note',
                changed: { note: 2 },
                assignments: [left],
            }),
        ).status,
        'known',
    )
    assert.equal(
        decodeOperation(
            wire('nse.property.set', { subject: 'bpm', changed: { bpm: 2 }, assignments: [left] }),
        ).status,
        'unsupported',
    )
    const mixed = {
        subject: 'objects',
        changed: { note: 1, timeScale: 1 },
        assignments: [{ field: 'beat', before: { mode: 'varying' }, after: { mode: 'varying' } }],
    }
    assert.equal(decodeOperation(wire('nse.property.set', mixed)).status, 'known')
    assert.equal(
        decodeOperation(wire('nse.property.set', { ...mixed, assignments: [left] })).status,
        'unsupported',
    )
    assert.equal(
        decodeOperation(
            wire('nse.property.set', {
                subject: 'note',
                changed: { note: 1 },
                assignments: [left, left],
            }),
        ).status,
        'unsupported',
    )
    assert.equal(
        decodeOperation(
            wire('nse.property.set', {
                subject: 'timeScale',
                changed: { timeScale: 1 },
                assignments: [
                    {
                        field: 'timeScaleEase',
                        before: { mode: 'uniform', value: 'inBack' },
                        after: { mode: 'uniform', value: 'inBack' },
                    },
                ],
            }),
        ).status,
        'unsupported',
    )
    assert.equal(
        decodeOperation(
            wire('nse.property.set', {
                subject: 'note',
                changed: { note: 1 },
                assignments: [
                    {
                        field: 'connectorEase',
                        before: { mode: 'uniform', value: 'type:in' },
                        after: { mode: 'uniform', value: 'type:in' },
                    },
                ],
            }),
        ).status,
        'unsupported',
    )
})

test('native union rejects wrong operation parameters and field value types at compile time', () => {
    const valid: NativeOperationInput = { id: 'nse.note.add', data: { created: 2 } }
    assert.equal(valid.id, 'nse.note.add')
    // @ts-expect-error A creation is not a movement receipt.
    const wrongCount: NativeOperationInput = { id: 'nse.note.add', data: { targets: 2 } }
    // @ts-expect-error A BPM cannot have Flick Direction.
    const wrongSubject: NativeOperationInput = {
        id: 'nse.property.set',
        data: {
            subject: 'bpm',
            changed: { bpm: 1 },
            assignments: [
                {
                    field: 'flickDirection',
                    before: { mode: 'uniform', value: 'none' },
                    after: { mode: 'uniform', value: 'up' },
                },
            ],
        },
    }
    // @ts-expect-error A boolean property is not a numeric value.
    const wrongValue: NativeOperationInput = {
        id: 'nse.property.set',
        data: {
            subject: 'note',
            changed: { note: 1 },
            assignments: [
                {
                    field: 'isCritical',
                    before: { mode: 'uniform', value: false },
                    after: { mode: 'uniform', value: 1 },
                },
            ],
        },
    }
    assert(wrongCount && wrongSubject && wrongValue)
})

test('owner domains and destination types are coupled, including bulk moves', () => {
    for (const kind of ['group', 'stage'] as const)
        assert.equal(
            decodeOperation(
                wire('nse.owner.create', {
                    target: { kind, id: 1, name: { text: 'Owner' } },
                    destination: null,
                    gathered: 1,
                }),
            ).status,
            'unsupported',
        )
    const groupFolder = { kind: 'groupFolder', id: 2, name: { text: 'Folder' } } as const
    const stageFolder = { ...groupFolder, kind: 'stageFolder' } as const
    for (const [domain, wrong, right] of [
        ['group', stageFolder, groupFolder],
        ['stage', groupFolder, stageFolder],
    ] as const) {
        const invalid = wire('nse.owner.moveMany', { domain, targets: 2, destination: wrong })
        const decoded = decodeOperation(invalid)
        assert.equal(decoded.status, 'unsupported')
        assert.equal(decoded.raw, invalid)
        assert.throws(() =>
            make({ id: 'nse.owner.moveMany', data: { domain, targets: 2, destination: wrong } }),
        )
        assert.equal(
            decodeOperation(wire('nse.owner.moveMany', { domain, targets: 2, destination: right }))
                .status,
            'known',
        )
        assert.equal(
            decodeOperation(wire('nse.owner.moveMany', { domain, targets: 2, destination: null }))
                .status,
            'known',
        )
    }
    assert.equal(
        decodeOperation(
            wire('nse.owner.move', {
                target: groupFolder,
                destination: groupFolder,
                category: 'intoFolder',
            }),
        ).status,
        'unsupported',
    )
    assert.equal(
        decodeOperation(wire('nse.owner.duplicate', { domain: 'group', created: { stage: 1 } }))
            .status,
        'unsupported',
    )
})

test('group keys sum only additive units and preserve visible semantic boundaries', () => {
    const add1 = operationGroup(make({ id: 'nse.note.add', data: { created: 1 } }))
    const add12 = operationGroup(make({ id: 'nse.note.add', data: { created: 12 } }))
    assert.equal(add1?.key, add12?.key)
    assert.deepEqual(add12?.metric, { unit: 'native', counts: { note: 12 } })
    const move = operationGroup(
        make({ id: 'nse.object.move', data: { subject: 'note', changed: { note: 12 } } }),
    )
    assert.equal(move?.metric, undefined)
    assert.notEqual(move?.key, add12?.key)
    const property = (field: 'left' | 'size') =>
        operationGroup(
            make({
                id: 'nse.property.set',
                data: {
                    subject: 'note',
                    changed: { note: 1 },
                    assignments: [
                        {
                            field,
                            before: { mode: 'uniform', value: 0 },
                            after: { mode: 'uniform', value: 1 },
                        },
                    ],
                },
            }),
        )
    assert.notEqual(property('left')?.key, property('size')?.key)
    const target = { kind: 'group', id: 1, name: { text: 'Same name' } } as const
    const rename = (id: number) =>
        operationGroup(
            make({
                id: 'nse.owner.rename',
                data: {
                    target: { ...target, id },
                    before: { text: 'A' },
                    after: { text: 'B' },
                },
            }),
        )
    assert.notEqual(rename(1)?.key, rename(2)?.key)
    const replaced = operationGroup(
        make({
            id: 'nse.object.replace',
            data: {
                subject: 'timeScale',
                changed: { timeScale: 1 },
                displaced: { timeScale: 2 },
            },
        }),
    )
    assert.equal(replaced?.family, 'replace')
    assert.equal(replaced?.metric, undefined)
    // A step that created nothing groups with nothing.
    assert.equal(
        operationGroup(make({ id: 'nse.object.add', data: { subject: 'bpm', created: 0 } })),
        undefined,
    )
    const flip = (subject: 'note' | 'bpm', axis: 'horizontal' | 'vertical') =>
        operationGroup(
            make({
                id: 'nse.object.flip',
                data: { subject, axis, changed: { [subject]: 1 } },
            }),
        )
    assert.equal(flip('note', 'horizontal')?.key, flip('bpm', 'horizontal')?.key)
    assert.notEqual(flip('note', 'horizontal')?.key, flip('note', 'vertical')?.key)
})

test('full steps preserve original push kind and opaque values without recursive contexts', () => {
    const raw = wire('future.restoreTool', { exactId: '9007199254740993' }, 9)
    const restored = captureStep({ kind: 'restore', operation: raw })
    assert.equal(restored.kind, 'restore')
    assert(equalJson(restored.operation, raw))
    assert(Object.isFrozen(restored))
    const event = captureEntryDescription({ kind: 'init', operation: raw })
    assert(equalJson(entryOperation(event), raw))
    assert.equal(pushedStep(event).kind, 'init')
    const undo = captureEntryDescription({ kind: 'undo', step: restored })
    assert(equalJson(entryOperation(undo), raw))
    assert.throws(() => captureEntryDescription({ kind: 'edit', step: restored }), /disagree/)
    assert.throws(
        () => captureEntryDescription({ kind: 'save', step: restored }),
        /event description/,
    )
    assert.throws(
        () => captureEntryDescription({ kind: 'restore', step: restored, operation: raw }),
        /step entry/,
    )
    assert.throws(() => captureStep({ kind: 'undo', operation: raw }), /Invalid History step/)
    assert.throws(
        () =>
            captureStep({
                kind: 'edit',
                operation: raw,
                recoveryContext: {
                    head: { ...restored, recoveryContext: {} },
                    dropped: [],
                    omitted: 0,
                },
            }),
        /Invalid History step/,
    )
})

test('recovery ordering keeps a new redo tail after 64 older descriptions', () => {
    const old = Array.from({ length: 64 }, (_, i) => step(i))
    const originalHead = step(64)
    const recovered = captureStep({
        kind: 'edit',
        operation: operationOf({
            id: 'nse.recovery',
            data: { droppedSteps: 64 },
        }),
        recoveryContext: createRecoveryContext(originalHead, old, old.length),
    })
    const sources = recoverySources(recovered)
    assert(equalJson(sources.head.operation, originalHead.operation))
    const redoTail = step(65)
    const context = createRecoveryContext(
        sources.head,
        [...sources.dropped, redoTail],
        sources.headIndex,
        sources.omitted,
    )
    assert.equal(context.dropped.length, 64)
    assert.equal(context.omitted, 1)
    assert(equalJson(context.dropped[63]!.operation, redoTail.operation))
    assert(equalJson(context.dropped[0]!.operation, old[1]!.operation))
    const repeated = recoverySources(captureStep({ ...recovered, recoveryContext: context }))
    assert(equalJson(repeated.head.operation, originalHead.operation))
    assert.equal(repeated.dropped.length, 64)
})

test('unknown recovery-like heads stay essential while optional context has byte and count budgets', () => {
    const rawHead = wire('nse.recovery', { droppedSteps: 0, future: true }, 2)
    const oldHead = step(1)
    const recovered = captureStep({
        kind: 'edit',
        operation: rawHead,
        recoveryContext: createRecoveryContext(oldHead, [step(0)], 1),
    })
    const sources = recoverySources(recovered)
    assert(equalJson(sources.head.operation, rawHead))
    assert.equal(sources.dropped.length, 2)
    const large = (id: number) =>
        captureStep({
            kind: 'edit',
            operation: wire('future.large', { id, text: 'x'.repeat(70_000) }),
        })
    const newer = large(2)
    const context = createRecoveryContext(sources.head, [large(1), newer], 1, 3)
    assert.equal(context.dropped.length, 1)
    assert.equal(context.omitted, 4)
    assert.equal(context.headIndex, 0)
    assert(equalJson(context.dropped[0]!.operation, newer.operation))
    assert(equalJson(context.head.operation, rawHead))
    assert(jsonBytes(context.dropped as unknown as JsonValue) <= RECOVERY_CONTEXT_BYTES)
    assert.throws(
        () =>
            createRecoveryContext(
                sources.head,
                Array.from({ length: 65 }, () => step(0)),
                0,
                Number.MAX_SAFE_INTEGER,
            ),
        /overflow/,
    )
})

test('persisted recovery head position survives demotion and newest-context trimming', () => {
    const optional = Array.from({ length: 64 }, (_, i) => step(i))
    const head = step(100)
    for (const headIndex of [0, 1, 32, 64]) {
        const prior = captureStep(
            JSON.parse(
                JSON.stringify({
                    kind: 'edit',
                    operation: operationOf({
                        id: 'nse.recovery',
                        data: { droppedSteps: 64 },
                    }),
                    recoveryContext: createRecoveryContext(head, optional, headIndex),
                }),
            ),
        )
        const sources = recoverySources(prior)
        assert.equal(sources.headIndex, headIndex)
        const ordered = [...sources.dropped]
        ordered.splice(sources.headIndex, 0, sources.head)
        const expected = [...optional]
        expected.splice(headIndex, 0, head)
        const next = createRecoveryContext(step(200), ordered, ordered.length, sources.omitted)
        assert.equal(next.omitted, 1)
        assert.equal(next.headIndex, 64)
        assert(
            equalJson(
                next.dropped as unknown as JsonValue,
                expected.slice(1) as unknown as JsonValue,
            ),
        )
        assert.equal(
            next.dropped.some((item) => equalJson(item.operation, head.operation)),
            headIndex !== 0,
        )
    }
    assert.throws(() => createRecoveryContext(head, optional, 65), /head position/)
    assert.throws(
        () =>
            captureStep({
                kind: 'edit',
                operation: null,
                recoveryContext: {
                    head,
                    headIndex: 1,
                    dropped: [],
                    omitted: 0,
                },
            }),
        /Invalid History step/,
    )
})

test('recovered events retain immutable context independently of a pushed step', () => {
    const head = step(1)
    const raw = { head, headIndex: 1, dropped: [step(0), step(2)], omitted: 3 }
    const recoveryContext = captureRecoveryContext(raw)
    const operation = wire('future.recovery', { version: 8 })
    const event = captureEntryDescription({ kind: 'recovered', operation, recoveryContext })
    raw.dropped.length = 0
    assert.equal(event.kind, 'recovered')
    if (event.kind !== 'recovered') throw new Error('Expected recovered event')
    assert.equal(event.recoveryContext.dropped.length, 2)
    assert.equal(event.recoveryContext.headIndex, 1)
    assert(Object.isFrozen(event.recoveryContext.dropped))
    assert(equalJson(entryOperation(event), operation))
    assert(
        equalJson(
            captureEntryDescription(JSON.parse(JSON.stringify(event))) as unknown as JsonValue,
            event as unknown as JsonValue,
        ),
    )
    assert.throws(
        () => captureEntryDescription({ kind: 'recovered', operation }),
        /recovered entry/,
    )
    assert.throws(
        () => captureEntryDescription({ kind: 'save', operation, recoveryContext }),
        /event description/,
    )
    assert.throws(
        () => captureEntryDescription({ kind: 'edit', step: head, recoveryContext }),
        /step entry/,
    )
    assert.throws(
        () => captureRecoveryContext({ ...recoveryContext, omitted: Number.MAX_SAFE_INTEGER }),
        /recovery context/,
    )
    assert.throws(() => pushedStep(event), /does not push/)
})

// `x`, the one ignorable carrier of a structural object (§1.6.11.8)

const sameJson = (actual: unknown, expected: JsonValue) =>
    assert(equalJson(actual as JsonValue, expected))

test('x is accepted on a step, a recovery context and its items, and carried by value', () => {
    const operation = wire('future.action', { index: 1 })
    const x = { future: [1, { deep: true }], when: 1792126800000 }
    const stepWithX = captureStep({ kind: 'edit', operation, x })
    sameJson(stepWithX.x, x)
    assert(Object.isFrozen(stepWithX.x))
    // A step without one is the step v1 writes: no key at all.
    assert.equal('x' in captureStep({ kind: 'edit', operation }), false)

    const head = captureStep({ kind: 'edit', operation, x: { head: true } })
    const item = captureStep({ kind: 'edit', operation: wire('future.action', { index: 2 }), x })
    const context = createRecoveryContext(head, [item], 1)
    sameJson(context.head.x, { head: true })
    sameJson(context.dropped[0]?.x, x)
    assert.equal(context.x, undefined)

    // The context and its items carry their own: a step holds them whole.
    const withContext = captureStep({
        kind: 'edit',
        operation,
        x,
        recoveryContext: { ...context, x: { context: 1 } },
    })
    sameJson(withContext.recoveryContext?.x, { context: 1 })
    sameJson(withContext.recoveryContext?.dropped[0]?.x, x)
    sameJson(captureRecoveryContext(withContext.recoveryContext)?.dropped[0]?.x, x)

    // Flattening a step into a description keeps its x with it.
    const sources = recoverySources(withContext)
    sameJson(sources.head.x, x)
    sameJson(sources.dropped[0]?.x, x)
    sameJson(recoverySources(stepWithX).head.x, x)

    // An entry holds a step, or a recovered event's context, whole.
    const entry = captureEntryDescription({ kind: 'edit', step: stepWithX })
    sameJson(entry.step?.x, x)
    const recovered = captureEntryDescription({
        kind: 'recovered',
        operation,
        recoveryContext: { ...context, x },
    })
    sameJson(recovered.recoveryContext?.x, x)
})

test('x must be a JSON object within the operation byte limit; no other key is ignorable', () => {
    const operation = wire('future.action', {})
    for (const x of [[1], 'x', 1, null, true]) {
        assert.throws(() => captureStep({ kind: 'edit', operation, x }), /Invalid History step/)
        assert.throws(
            () =>
                captureStep({
                    kind: 'edit',
                    operation,
                    recoveryContext: {
                        head: { kind: 'edit', operation, x },
                        headIndex: 0,
                        dropped: [],
                        omitted: 0,
                    },
                }),
            /Invalid History step/,
        )
    }
    const big = { text: 'x'.repeat(OPERATION_WIRE_BYTES) }
    assert.throws(() => captureStep({ kind: 'edit', operation, x: big }))
    // Any other key is still refused, at every level: a reader that finds one says "newer".
    assert.throws(() => captureStep({ kind: 'edit', operation, zz: 1 }), /Invalid History step/)
    assert.throws(
        () =>
            captureStep({
                kind: 'edit',
                operation,
                recoveryContext: {
                    head: { kind: 'edit', operation, zz: 1 },
                    headIndex: 0,
                    dropped: [],
                    omitted: 0,
                },
            }),
        /Invalid History step/,
    )
    assert.throws(
        () =>
            captureStep({
                kind: 'edit',
                operation,
                recoveryContext: {
                    head: { kind: 'edit', operation },
                    headIndex: 0,
                    dropped: [],
                    omitted: 0,
                    zz: 1,
                },
            }),
        /Invalid History step/,
    )
})

test('unknown keys are found at the levels of a step, a context and an entry', () => {
    const operation = wire('future.action', {})
    const stripped = stripUnknownStepKeys(
        {
            kind: 'edit',
            operation,
            zz: 1,
            x: { kept: 1 },
            recoveryContext: {
                head: { kind: 'edit', operation, a: 1 },
                headIndex: 0,
                dropped: [{ kind: 'edit', operation, b: 1 }],
                omitted: 0,
                c: 1,
            },
        },
        'step.',
    )
    assert.deepEqual(stripped.unknown.sort(), [
        'step.recoveryContext.c',
        'step.recoveryContext.dropped[0].b',
        'step.recoveryContext.head.a',
        'step.zz',
    ])
    assert.doesNotThrow(() => captureStep(stripped.value))
    const entry = stripUnknownEntryKeys({
        kind: 'recovered',
        operation,
        recoveryContext: {
            head: { kind: 'edit', operation },
            headIndex: 0,
            dropped: [],
            omitted: 0,
            q: 1,
        },
    })
    assert.deepEqual(entry.unknown, ['recoveryContext.q'])
    assert.doesNotThrow(() => captureEntryDescription(entry.value))
    // Not objects: left alone, for the codec to refuse.
    assert.deepEqual(stripUnknownStepKeys(5), { value: 5, unknown: [] })
})
