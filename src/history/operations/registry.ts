import {
    boolean,
    codec,
    count,
    finite,
    literal,
    nil,
    object,
    oneOf,
    refine,
    union,
    type ValueOf,
} from './codec'
import {
    assignments,
    checkedSum,
    excerpt,
    FALLBACK_CODE_POINTS,
    fieldApplies,
    nameText,
    nativeCounts,
    nativeKind,
    nativeKinds,
    ownerCounts,
    ownerReference,
    subject,
    type Assignment,
    type FieldFor,
    type NativeKind,
    type OwnerReference,
} from './fields'
import {
    captureJson,
    isJsonText,
    isObject,
    jsonBytes,
    OPERATION_NATIVE_BYTES,
    OperationDataError,
    owns,
    type JsonValue,
} from './json'

export type PropertyData =
    | {
          [S in NativeKind]: {
              readonly subject: S
              readonly targets: number
              readonly assignments: readonly Assignment<FieldFor<S>>[]
          }
      }[NativeKind]
    | {
          readonly subject: 'objects'
          readonly subjects: readonly NativeKind[]
          readonly targets: number
          readonly assignments: readonly Assignment[]
      }

const propertyData = codec<PropertyData>((value) => {
    if (
        !isObject(value) ||
        !subject.is(value.subject) ||
        !count.is(value.targets) ||
        !assignments.is(value.assignments)
    )
        return false
    const keys = [
        'subject',
        'targets',
        'assignments',
        ...(value.subject === 'objects' ? ['subjects'] : []),
    ]
    if (Object.keys(value).length !== keys.length || !keys.every((key) => owns(value, key)))
        return false
    const kinds = value.subject === 'objects' ? value.subjects : [value.subject]
    if (
        !Array.isArray(kinds) ||
        kinds.length < (value.subject === 'objects' ? 2 : 1) ||
        kinds.length > nativeKinds.length ||
        !kinds.every(nativeKind.is) ||
        new Set(kinds).size !== kinds.length
    )
        return false
    const applied = value.assignments
    return (
        applied.every(({ field }) => kinds.some((kind) => fieldApplies(field, kind))) &&
        kinds.every((kind) => applied.some(({ field }) => fieldApplies(field, kind)))
    )
})

const changedTargets = refine(
    object(
        { subject, targets: count },
        {
            displaced: nativeCounts,
            retainedInitialBpm: literal(true),
        },
    ),
    ({ subject, retainedInitialBpm }) =>
        !retainedInitialBpm || subject === 'bpm' || subject === 'objects',
)
const folder = object({ kind: oneOf(['groupFolder', 'stageFolder']), id: count, name: nameText })
const destination = union(folder, nil)
const scalarChange = object({ before: finite, after: finite })
const fileChange = object({ before: union(nameText, nil), after: union(nameText, nil) })
const ownerDomain = oneOf(['group', 'stage'])

const ownerChange = union(
    object({
        field: literal('forceNoteSpeed'),
        before: union(finite, nil),
        after: union(finite, nil),
    }),
    object({ field: oneOf(['isFromStart', 'isUntilEnd']), before: boolean, after: boolean }),
    object({
        field: literal('generateSimLines'),
        before: oneOf(['global', 'isolated']),
        after: oneOf(['global', 'isolated']),
    }),
)
export type OwnerChange = ValueOf<typeof ownerChange>
const ownerChanges = codec<readonly OwnerChange[]>(
    (value) =>
        Array.isArray(value) &&
        value.length > 0 &&
        value.length <= 3 &&
        value.every(ownerChange.is) &&
        value.every((item, i) => i === 0 || (value[i - 1]?.field ?? '') < item.field),
)
const ownerSet = refine(
    object({ target: ownerReference, changes: ownerChanges }),
    ({ target, changes }) =>
        target.kind === 'group'
            ? changes.every(({ field }) => field === 'forceNoteSpeed')
            : target.kind === 'stage' && changes.every(({ field }) => field !== 'forceNoteSpeed'),
)
const inDomain = (domain: 'group' | 'stage', target: OwnerReference) =>
    target.kind === domain || target.kind === `${domain}Folder`
const domainCounts = (domain: 'group' | 'stage', values: ValueOf<typeof ownerCounts>) =>
    Object.keys(values).every((kind) => kind === domain || kind === `${domain}Folder`) &&
    checkedSum(Object.values(values)) !== undefined

export const operationCodecs = {
    'nse.note.add': object({ created: count }),
    'nse.note.generate': object({ created: count }),
    'nse.object.add': refine(
        object(
            { subject: oneOf(nativeKinds.filter((kind) => kind !== 'note')), created: count },
            { displaced: nativeCounts },
        ),
        ({ subject, displaced }) =>
            !displaced ||
            ((subject === 'bpm' || subject === 'timeScale') &&
                Object.keys(displaced).every((kind) => kind === subject)),
    ),
    'nse.object.edit': changedTargets,
    'nse.object.move': changedTargets,
    'nse.object.replace': refine(
        object(
            { subject: oneOf(['bpm', 'timeScale']), targets: count, displaced: nativeCounts },
            { retainedInitialBpm: literal(true) },
        ),
        ({ subject, displaced, retainedInitialBpm }) =>
            Object.keys(displaced).every((kind) => kind === subject) &&
            (!retainedInitialBpm || subject === 'bpm'),
    ),
    'nse.note.elevation': object({ targets: count }),
    'nse.object.paste': object({
        placed: nativeCounts,
        displaced: nativeCounts,
        variant: oneOf(['basic', 'composed']),
        flipped: boolean,
        at: oneOf(['pointer', 'position']),
    }),
    'nse.object.brush': propertyData,
    'nse.object.delete': object({ removed: nativeCounts }),
    'nse.object.cut': object({ removed: nativeCounts }),
    'nse.object.flip': object({ axis: oneOf(['horizontal', 'vertical']), subject, targets: count }),
    'nse.object.scale': object({
        axis: oneOf(['beats', 'width', 'elevation']),
        subject,
        targets: count,
        transform: union(
            object({ mode: literal('uniform'), factor: finite, pivot: finite }),
            object({ mode: literal('composed') }),
        ),
    }),
    'nse.note.combine': object({ notes: count }),
    'nse.note.split': object({ points: count }),
    'nse.note.vertical': object({ targets: count }),
    'nse.property.set': propertyData,
    'nse.header.set': object({
        field: oneOf(['initialLife', 'bgmOffset']),
        before: finite,
        after: finite,
    }),
    'nse.bgm.change': object({ file: fileChange }, { offset: scalarChange }),
    'nse.dynamicStages.enable': object({}),
    'nse.owner.create': refine(
        object({ target: ownerReference, destination, gathered: count }),
        ({ target, destination: to }) =>
            !to ||
            ((target.kind === 'group' || target.kind === 'stage') && inDomain(target.kind, to)),
    ),
    'nse.owner.rename': object({ target: ownerReference, before: nameText, after: nameText }),
    'nse.owner.set': ownerSet,
    'nse.owner.move': refine(
        object(
            {
                target: ownerReference,
                destination,
                category: oneOf(['reorder', 'intoFolder', 'outOfFolder']),
            },
            { fromIndex: count, toIndex: count },
        ),
        ({ target, destination: to, category }) =>
            (!to || inDomain(target.kind.startsWith('group') ? 'group' : 'stage', to)) &&
            (target.kind === 'group' ||
                target.kind === 'stage' ||
                (category === 'reorder' && to === null)) &&
            (category !== 'intoFolder' || to !== null) &&
            (category !== 'outOfFolder' || to === null),
    ),
    'nse.owner.moveMany': refine(
        object({ domain: ownerDomain, targets: count, destination }),
        ({ domain, destination: to }) => !to || inDomain(domain, to),
    ),
    'nse.owner.duplicate': refine(
        object({ domain: ownerDomain, created: ownerCounts }, { source: ownerReference }),
        ({ domain, created, source }) =>
            domainCounts(domain, created) && (!source || inDomain(domain, source)),
    ),
    'nse.owner.delete': refine(
        object({ domain: ownerDomain, removed: ownerCounts }, { target: ownerReference }),
        ({ domain, removed, target }) =>
            domainCounts(domain, removed) && (!target || inDomain(domain, target)),
    ),
    'nse.owner.ungroup': object({ target: folder, released: count }),
    'nse.origin': object(
        { origin: oneOf(['new', 'import', 'autoSave', 'recovery']) },
        { source: nameText },
    ),
    'nse.continue': object({ fromTime: count }, { source: nameText }),
    'nse.file.save': object({ file: nameText, delivery: oneOf(['file', 'download']) }),
    'nse.file.export': object({ file: nameText, delivery: oneOf(['file', 'download']) }),
    'nse.restore': object({ targetTime: count }, { source: nameText }),
    'nse.recovery': object({
        source: oneOf(['journal', 'local', 'autoSave']),
        droppedSteps: count,
    }),
    'nse.externalChange': object({}),
} as const

export type OperationId = keyof typeof operationCodecs
export type NativeOperationInput = {
    [K in OperationId]: { readonly id: K; readonly data: ValueOf<(typeof operationCodecs)[K]> }
}[OperationId]
export type OperationFallback = { readonly text: string; readonly locale: string }
export type NativeOperation = NativeOperationInput & {
    readonly version: 1
    readonly fallback: OperationFallback
}
export type OperationRenderer = (operation: NativeOperationInput, locale: string) => string

export type DecodedOperation =
    | { readonly status: 'known'; readonly raw: JsonValue; readonly operation: NativeOperation }
    | {
          readonly status: 'unsupported'
          readonly raw: JsonValue
          readonly fallback?: OperationFallback
      }

const fallbackCodec = object({ text: codec<string>(isJsonText), locale: codec<string>(isJsonText) })

export const fallbackOf = (raw: JsonValue): OperationFallback | undefined => {
    if (!isObject(raw) || !owns(raw, 'fallback') || !fallbackCodec.is(raw.fallback)) return
    return raw.fallback
}

export const decodeOperation = (raw: JsonValue): DecodedOperation => {
    const fallback = fallbackOf(raw)
    if (
        isObject(raw) &&
        Object.keys(raw).length === 4 &&
        owns(raw, 'id') &&
        owns(raw, 'version') &&
        owns(raw, 'data') &&
        owns(raw, 'fallback') &&
        typeof raw.id === 'string' &&
        owns(operationCodecs, raw.id) &&
        raw.version === 1 &&
        fallback &&
        jsonBytes(raw) <= OPERATION_NATIVE_BYTES &&
        operationCodecs[raw.id as OperationId].is(raw.data)
    )
        return { status: 'known', raw, operation: raw as unknown as NativeOperation }
    return { status: 'unsupported', raw, ...(fallback ? { fallback } : {}) }
}

export const captureOperation = (value: unknown) => captureJson(value)

export const createOperation = (
    input: NativeOperationInput,
    { locale, describe }: { locale: string; describe: OperationRenderer },
): NativeOperation => {
    if (!isJsonText(locale)) throw new OperationDataError('Operation locale must be text')
    const captured = captureJson(input, { bytes: OPERATION_NATIVE_BYTES })
    if (
        !isObject(captured) ||
        Object.keys(captured).length !== 2 ||
        typeof captured.id !== 'string' ||
        !owns(operationCodecs, captured.id) ||
        !operationCodecs[captured.id as OperationId].is(captured.data)
    )
        throw new OperationDataError('Invalid native operation')
    const known = captured as unknown as NativeOperationInput
    const description = excerpt(describe(known, locale), FALLBACK_CODE_POINTS)
    const fallback = {
        locale,
        text: description.truncated
            ? `${excerpt(description.text, FALLBACK_CODE_POINTS - 1).text}…`
            : description.text,
    }
    const result = captureJson(
        { ...known, version: 1, fallback },
        { bytes: OPERATION_NATIVE_BYTES },
    )
    return result as unknown as NativeOperation
}
