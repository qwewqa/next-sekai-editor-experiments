import { TIME_LIMIT } from '../../calendar/calendar'
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
    nativeCountsPlus,
    nativeKinds,
    ownerCounts,
    ownerCountsPlus,
    ownerReference,
    subject,
    subjectOfCounts,
    type Assignment,
    type FieldFor,
    type NativeKind,
    type OwnerReference,
    type Subject,
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

type Collateral = {
    /** Chart objects the edit replaced or removed that were not its operands. */
    readonly displaced?: ValueOf<typeof nativeCountsPlus>
    /**
     * The initial BPM stayed at beat 0: added back after a move, flip or scale took it away, or
     * (a BPM tool move) kept in place with a copy added at the new beat.
     */
    readonly retainedInitialBpm?: true
}

export type PropertyData =
    | {
          [S in NativeKind]: {
              readonly subject: S
              readonly changed: ValueOf<typeof nativeCountsPlus>
              readonly assignments: readonly Assignment<FieldFor<S>>[]
          } & Collateral
      }[NativeKind]
    | ({
          readonly subject: 'objects'
          readonly changed: ValueOf<typeof nativeCountsPlus>
          readonly assignments: readonly Assignment[]
      } & Collateral)

const collateralKeys = ['displaced', 'retainedInitialBpm']

const propertyData = codec<PropertyData>((value) => {
    if (
        !isObject(value) ||
        !subject.is(value.subject) ||
        !nativeCountsPlus.is(value.changed) ||
        !assignments.is(value.assignments)
    )
        return false
    const keys = ['subject', 'changed', 'assignments']
    const extra = Object.keys(value).filter((key) => !keys.includes(key))
    if (
        Object.keys(value).length !== keys.length + extra.length ||
        !keys.every((key) => owns(value, key)) ||
        !extra.every((key) => collateralKeys.includes(key)) ||
        ('displaced' in value && !nativeCountsPlus.is(value.displaced)) ||
        ('retainedInitialBpm' in value && value.retainedInitialBpm !== true)
    )
        return false
    // The subject is what the counts say, and a re-added initial BPM needs a BPM among them.
    if (
        value.subject !== subjectOfCounts(value.changed) ||
        (value.retainedInitialBpm && value.subject !== 'bpm' && value.subject !== 'objects')
    )
        return false
    const kinds = Object.keys(value.changed) as NativeKind[]
    const applied = value.assignments
    return (
        // Only a Beat assignment can displace a destination's object or move the initial BPM.
        (!hasCollateral(value) || applied.some(({ field }) => field === 'beat')) &&
        applied.every(({ field }) => kinds.some((kind) => fieldApplies(field, kind))) &&
        kinds.every((kind) => applied.some(({ field }) => fieldApplies(field, kind)))
    )
})

/**
 * Whether a step carries collateral (`displaced` or `retainedInitialBpm`). Property data and brush
 * need a Beat assignment for it, a flip the vertical axis and a scale the beats axis.
 */
const hasCollateral = (value: Collateral) => !!value.displaced || !!value.retainedInitialBpm
const agrees = (subject: unknown, changed: ValueOf<typeof nativeCounts>) =>
    !Object.keys(changed).length || subject === subjectOfCounts(changed)

const changedTargets = refine(
    object(
        { subject, changed: nativeCounts },
        {
            displaced: nativeCountsPlus,
            retainedInitialBpm: literal(true),
        },
    ),
    ({ subject, changed, retainedInitialBpm }) =>
        agrees(subject, changed) &&
        (!retainedInitialBpm || subject === 'bpm' || subject === 'objects'),
)
/** The kinds a Select drag resizes: a note's width, a camera or stage mask event's range. */
export const resizableSubjects: readonly Subject[] = ['note', 'cameraEvent', 'stageMaskEvent']

/**
 * A move. `resized` says the drag took an edge and changed only the lanes' extent: it names the
 * step a resize and not a move. It needs a resizable subject, and displaces nothing.
 */
const movedTargets = refine(
    object(
        { subject, changed: nativeCounts },
        {
            displaced: nativeCountsPlus,
            retainedInitialBpm: literal(true),
            resized: literal(true),
        },
    ),
    ({ subject, changed, displaced, retainedInitialBpm, resized }) =>
        agrees(subject, changed) &&
        (!retainedInitialBpm || subject === 'bpm' || subject === 'objects') &&
        (!resized || (resizableSubjects.includes(subject) && !displaced && !retainedInitialBpm)),
)
const folder = object({ kind: oneOf(['groupFolder', 'stageFolder']), id: count, name: nameText })
const destination = union(folder, nil)
const scalarChange = object({ before: finite, after: finite })
const fileName = union(nameText, nil)
const fileChange = object({ before: fileName, after: fileName })
const ownerDomain = oneOf(['group', 'stage'])

/**
 * One field of a Level Info Apply: its text fields before and after as captured names
 * (an unset field is the empty name), the rating, how many tags by title were added and removed
 * and whether the kept tags moved (the tags themselves are in the snapshots, which Property
 * Changes diffs), the cover and preview as files, and the Initial Life the dialog also holds.
 */
const levelInfoChange = union(
    object({
        field: oneOf(['title', 'artists', 'author', 'description']),
        before: nameText,
        after: nameText,
    }),
    object({ field: literal('rating'), before: union(finite, nil), after: union(finite, nil) }),
    object(
        { field: literal('tags'), added: count, removed: count },
        // Tags kept but moved are a change of state.
        { reordered: literal(true) },
    ),
    object({ field: oneOf(['cover', 'preview']), before: fileName, after: fileName }),
    object({ field: literal('initialLife'), before: finite, after: finite }),
)
export type LevelInfoChange = ValueOf<typeof levelInfoChange>
/** The dialog's field order, which a step's changes follow. */
export const levelInfoFields = [
    'title',
    'artists',
    'author',
    'rating',
    'tags',
    'description',
    'cover',
    'preview',
    'initialLife',
] as const
const fieldAt = (change: LevelInfoChange) => levelInfoFields.indexOf(change.field)
/** Whether a change changes anything. A cut name may hide a real difference, so it counts. */
const isChange = (change: LevelInfoChange) => {
    if (change.field === 'tags') return change.added + change.removed > 0 || !!change.reordered
    if (change.field === 'rating' || change.field === 'initialLife')
        return change.before !== change.after
    // Names and files: equal captured names are no change, unless a cut name hides a difference.
    const { before, after } = change
    const same =
        before === after ||
        (!!before &&
            !!after &&
            before.text === after.text &&
            !before.truncated === !after.truncated)
    return !same || !!before?.truncated
}
/**
 * One Apply is one step: its changes in the dialog's field order, each field once, each one a
 * change. A step that changes only Initial Life is `nse.header.set`, so each id names one result.
 */
const levelInfoChanges = codec<readonly LevelInfoChange[]>(
    (value) =>
        Array.isArray(value) &&
        value.length > 0 &&
        value.length <= 9 &&
        value.every(levelInfoChange.is) &&
        value.map(fieldAt).every((at, i, all) => i === 0 || (all[i - 1] ?? 0) < at) &&
        value.every(isChange) &&
        (value.length > 1 || value[0]?.field !== 'initialLife'),
)

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
/** The chart objects an entry owns: a group's notes and time scales, a stage's notes and stage events. */
const ownedKinds: Record<'group' | 'stage', readonly string[]> = {
    group: ['note', 'timeScale'],
    stage: ['note', 'stageMaskEvent', 'stagePivotEvent', 'stageStyleEvent', 'stageTransformEvent'],
}
const ownedObjects = (domain: 'group' | 'stage', objects: object | undefined) =>
    !objects || Object.keys(objects).every((kind) => ownedKinds[domain].includes(kind))

/** A time as a Date takes it: a whole number of milliseconds within ±8.64e15. */
const time = refine(count, (value) => value <= TIME_LIMIT)

export const operationCodecs = {
    'nse.note.add': object({ created: count }),
    'nse.note.generate': object({ created: count }),
    'nse.object.add': object({
        subject: oneOf(nativeKinds.filter((kind) => kind !== 'note')),
        created: count,
    }),
    'nse.object.edit': changedTargets,
    'nse.object.move': movedTargets,
    // A BPM or time scale moved onto an occupied beat. Both kinds' counts name only the subject.
    'nse.object.replace': refine(
        object(
            {
                subject: oneOf(['bpm', 'timeScale']),
                changed: nativeCounts,
                displaced: nativeCountsPlus,
            },
            { retainedInitialBpm: literal(true) },
        ),
        ({ subject, changed, displaced, retainedInitialBpm }) =>
            agrees(subject, changed) &&
            Object.keys(displaced).every((kind) => kind === subject) &&
            (!retainedInitialBpm || subject === 'bpm'),
    ),
    'nse.note.elevation': object({ targets: count }),
    'nse.object.paste': object(
        {
            placed: nativeCountsPlus,
            variant: oneOf(['basic', 'composed']),
            flipped: boolean,
            at: oneOf(['pointer', 'position']),
        },
        { displaced: nativeCountsPlus },
    ),
    'nse.object.brush': propertyData,
    'nse.object.delete': object({ removed: nativeCounts }),
    'nse.object.cut': object({ removed: nativeCounts }),
    // Only a vertical flip moves objects onto other beats, so only it can displace.
    'nse.object.flip': refine(
        object(
            { axis: oneOf(['horizontal', 'vertical']), subject, changed: nativeCounts },
            { displaced: nativeCountsPlus, retainedInitialBpm: literal(true) },
        ),
        (value) =>
            agrees(value.subject, value.changed) &&
            (!hasCollateral(value) || value.axis === 'vertical') &&
            (!value.retainedInitialBpm || value.subject === 'bpm' || value.subject === 'objects'),
    ),
    // Only scaling beats moves objects onto other beats.
    'nse.object.scale': refine(
        object(
            {
                axis: oneOf(['beats', 'width', 'elevation']),
                subject,
                changed: nativeCounts,
                transform: union(
                    object({ mode: literal('uniform'), factor: finite, pivot: finite }),
                    object({ mode: literal('composed') }),
                ),
            },
            { displaced: nativeCountsPlus, retainedInitialBpm: literal(true) },
        ),
        (value) =>
            agrees(value.subject, value.changed) &&
            (!hasCollateral(value) || value.axis === 'beats') &&
            (!value.retainedInitialBpm || value.subject === 'bpm' || value.subject === 'objects'),
    ),
    'nse.note.combine': object({ targets: count }),
    'nse.note.split': object({ targets: count }),
    'nse.note.vertical': object({ targets: count }),
    'nse.property.set': propertyData,
    'nse.header.set': object({
        field: oneOf(['initialLife', 'bgmOffset']),
        before: finite,
        after: finite,
    }),
    'nse.bgm.change': object({ file: fileChange }, { offset: scalarChange }),
    'nse.levelInfo.set': object({ changes: levelInfoChanges }),
    'nse.dynamicStages.enable': object({ created: nativeCounts }),
    'nse.owner.create': refine(
        object({ target: ownerReference, destination, gathered: count }),
        ({ target, destination: to, gathered }) =>
            ((target.kind !== 'group' && target.kind !== 'stage') || gathered === 0) &&
            (!to ||
                ((target.kind === 'group' || target.kind === 'stage') &&
                    inDomain(target.kind, to))),
    ),
    'nse.owner.rename': object({ target: ownerReference, before: nameText, after: nameText }),
    'nse.owner.set': ownerSet,
    // fromIndex and toIndex are 0-based. For a group or stage they are positions among the
    // domain's entries in tree order (`entriesInTreeOrder`); for a folder, positions among the
    // top-level items. Step Details shows them 1-based, for a reorder only.
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
    // `objects` are the copies of the chart objects the duplicated entries own.
    'nse.owner.duplicate': refine(
        object(
            { domain: ownerDomain, created: ownerCountsPlus },
            { source: ownerReference, objects: nativeCountsPlus },
        ),
        ({ domain, created, source, objects }) =>
            domainCounts(domain, created) &&
            ownedObjects(domain, objects) &&
            (!source || inDomain(domain, source)),
    ),
    // `objects` are the chart objects deleted with the entries; `replacement` is the default
    // entry created when the last one went.
    'nse.owner.delete': refine(
        object(
            { domain: ownerDomain, removed: ownerCountsPlus },
            { target: ownerReference, objects: nativeCountsPlus, replacement: ownerReference },
        ),
        ({ domain, removed, target, objects, replacement }) =>
            domainCounts(domain, removed) &&
            ownedObjects(domain, objects) &&
            (!target || inDomain(domain, target)) &&
            (!replacement || replacement.kind === domain),
    ),
    'nse.owner.ungroup': object({ target: folder, released: count }),
    // The file an import came from; no other origin has one.
    'nse.origin': refine(
        object({ origin: oneOf(['new', 'import', 'autoSave', 'recovery']) }, { source: nameText }),
        ({ origin, source }) => source === undefined || origin === 'import',
    ),
    'nse.continue': object({ fromTime: time }),
    'nse.file.save': object({ file: nameText, delivery: oneOf(['file', 'download']) }),
    'nse.file.export': object({ file: nameText, delivery: oneOf(['file', 'download']) }),
    'nse.restore': object({ targetTime: time }),
    'nse.recovery': object({ droppedSteps: count }),
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
