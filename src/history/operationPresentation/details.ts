import {
    checkedSum,
    decodeOperation,
    isObject,
    nativeKinds,
    operationCodecs,
    ownerKinds,
    owns,
    type AssignedValue,
    type FieldId,
    type JsonValue,
    type NameText,
    type NativeCounts,
    type NativeKind,
    type NativeOperationInput,
    type OwnerKind,
    type OwnerReference,
} from '../operations'
import { renderOperationRecipe } from './aggregate'
import { describeMember, namedOwnerDescription } from './format'
import { memberOperation, memberRecoveryContext } from './members'
import type {
    DetailRow,
    DetailStep,
    DetailText,
    OperationDetails,
    OperationMember,
    OperationRecipe,
    OperationTextContext,
} from './types'
import {
    message,
    nameText,
    numberText,
    operationFieldLabel,
    operationValueText,
    ownerFieldLabel,
    ownerValueText,
    quoted,
} from './values'

type Counts = Readonly<Partial<Record<NativeKind | OwnerKind, number>>>
type RecordData = {
    readonly rows: DetailRow[]
    readonly facts: string[]
    readonly note?: string
    readonly lang?: string
}

const plain = (text: string): DetailText => ({ text })
const placeholder = (text: string): DetailText => ({ text, placeholder: true })

/**
 * A captured name: bare, with "Not set" for none. An empty name is a name (an imported group or
 * folder can have one): it reads quoted empty, as in prose, so it is not mistaken for no entry.
 * A file has no such thing, so an empty file name reads Not set.
 */
const nameDetail = (
    name: NameText | null | undefined,
    context: OperationTextContext,
    { file = false }: { file?: boolean } = {},
): DetailText =>
    !name || (file && !name.text && !name.truncated)
        ? placeholder(context.strings.historyChanges.notSet)
        : {
              text: !name.text && !name.truncated ? quoted('', context) : nameText(name),
              ...(name.truncated ? { shortened: true as const } : {}),
          }

const sameText = (a: DetailText, b: DetailText) =>
    a.text === b.text && !a.placeholder === !b.placeholder

const countPhrase = (
    kind: NativeKind | OwnerKind,
    value: number,
    context: OperationTextContext,
) => {
    const t = context.strings
    const phrases = t.history.details.counts
    switch (kind) {
        case 'note':
        case 'bpm':
        case 'timeScale':
        case 'group':
        case 'stage':
        case 'groupFolder':
        case 'stageFolder':
            return message(context, phrases[kind], value)
        case 'cameraEvent':
        case 'stageMaskEvent':
        case 'stagePivotEvent':
        case 'stageStyleEvent':
        case 'stageTransformEvent':
            return message(context, phrases.event, value, t.eventKinds[kind])
    }
}

/** One phrase per kind, in the kind order: notes, BPM changes, time scales, events, then owners. */
export const countItems = (counts: Counts, context: OperationTextContext) =>
    [...nativeKinds, ...ownerKinds].flatMap((kind) => {
        const value = counts[kind]
        return value ? [countPhrase(kind, value, context)] : []
    })

const countsRow = (key: string, label: string, items: readonly string[]): readonly DetailRow[] =>
    items.length ? [{ kind: 'counts', key, label, items }] : []

const changeRow = (
    key: string,
    label: string,
    before: DetailText,
    after: DetailText,
): readonly DetailRow[] =>
    sameText(before, after) ? [] : [{ kind: 'change', key, label, before, after }]

const valueRow = (key: string, label: string, value: DetailText): readonly DetailRow[] => [
    { kind: 'value', key, label, value },
]

const numberChange = (
    key: string,
    label: string,
    before: number,
    after: number,
    context: OperationTextContext,
    shift = 0,
) =>
    changeRow(
        key,
        label,
        plain(numberText(before, context, shift)),
        plain(numberText(after, context, shift)),
    )

const assigned = (
    field: FieldId,
    value: AssignedValue,
    context: OperationTextContext,
): DetailText =>
    value.mode === 'varying'
        ? placeholder(context.strings.history.details.varying)
        : typeof value.value === 'object'
          ? nameDetail(value.value.name, context)
          : plain(operationValueText(field, value.value, context))

const ownerValue = (value: Parameters<typeof ownerValueText>[0], context: OperationTextContext) =>
    value === null
        ? placeholder(context.strings.historyChanges.notSet)
        : plain(ownerValueText(value, context))

const total = (counts: Counts) => checkedSum(Object.values(counts)) ?? 0
const kindCount = (counts: Counts) => Object.keys(counts).length

/** Whether a title already names this entry alone, so a count of exactly it would repeat the title. */
const namesEntry = (entry: OwnerReference | undefined, counts: Counts) =>
    !!entry && total(counts) !== 0 && kindCount(counts) === 1 && counts[entry.kind] === 1

/** Names that were cut for display, anywhere in the operation's data. */
const hasShortenedName = (value: unknown): boolean =>
    typeof value === 'object' &&
    value !== null &&
    (('truncated' in value && value.truncated === true && 'text' in value) ||
        Object.values(value).some(hasShortenedName))

const nativeRecord = (
    operation: NativeOperationInput,
    context: OperationTextContext,
): RecordData => {
    const t = context.strings
    const d = t.history.details
    const rows: DetailRow[] = []
    const facts: string[] = []
    const collateral = (data: { displaced?: NativeCounts; retainedInitialBpm?: true }) => {
        if (data.displaced)
            rows.push(...countsRow('displaced', d.displaced, countItems(data.displaced, context)))
    }
    const retained = (data: { retainedInitialBpm?: true }) => {
        if (data.retainedInitialBpm) facts.push(d.retainedInitialBpm)
    }
    const changed = (label: string, counts: NativeCounts, always: boolean) => {
        if (always || kindCount(counts) >= 2)
            rows.push(...countsRow('changed', label, countItems(counts, context)))
    }
    switch (operation.id) {
        case 'nse.note.add':
        case 'nse.note.generate':
        case 'nse.object.add':
        case 'nse.note.combine':
        case 'nse.note.split':
        case 'nse.note.vertical':
        case 'nse.note.elevation':
        case 'nse.owner.rename':
        case 'nse.owner.moveMany':
        case 'nse.origin':
        case 'nse.continue':
        case 'nse.file.save':
        case 'nse.restore':
        case 'nse.externalChange':
            break
        case 'nse.object.edit':
        case 'nse.object.move': {
            changed(d.changed, operation.data.changed, false)
            collateral(operation.data)
            retained(operation.data)
            break
        }
        case 'nse.object.replace': {
            const { subject, displaced } = operation.data
            // The title says one entry was replaced for each one changed.
            const same =
                kindCount(displaced) === 1 && displaced[subject] === total(operation.data.changed)
            if (!same) collateral(operation.data)
            retained(operation.data)
            break
        }
        case 'nse.object.paste': {
            rows.push(...countsRow('placed', d.placed, countItems(operation.data.placed, context)))
            collateral(operation.data)
            rows.push(
                ...valueRow(
                    'layout',
                    t.commands.editorLayout.title,
                    plain(t.sidebars.view.layout[operation.data.variant]),
                ),
                ...valueRow(
                    'at',
                    d.pasteLocation,
                    plain(d[operation.data.at === 'pointer' ? 'pointer' : 'position']),
                ),
            )
            if (operation.data.flipped) facts.push(d.pastedFlipped)
            break
        }
        case 'nse.object.brush':
        case 'nse.property.set': {
            changed(d.changed, operation.data.changed, false)
            collateral(operation.data)
            for (const assignment of operation.data.assignments)
                rows.push(
                    ...changeRow(
                        assignment.field,
                        operationFieldLabel(assignment.field, context),
                        assigned(assignment.field, assignment.before, context),
                        assigned(assignment.field, assignment.after, context),
                    ),
                )
            retained(operation.data)
            break
        }
        case 'nse.object.delete':
        case 'nse.object.cut':
            if (kindCount(operation.data.removed) >= 2)
                rows.push(
                    ...countsRow(
                        'removed',
                        t.historyChanges.removed,
                        countItems(operation.data.removed, context),
                    ),
                )
            break
        case 'nse.object.flip': {
            changed(d.changed, operation.data.changed, true)
            collateral(operation.data)
            retained(operation.data)
            break
        }
        case 'nse.object.scale': {
            changed(d.changed, operation.data.changed, true)
            collateral(operation.data)
            const { transform } = operation.data
            if (transform.mode === 'uniform')
                rows.push(
                    ...valueRow(
                        'factor',
                        t.commands.scaleSelection.factor,
                        plain(numberText(transform.factor, context)),
                    ),
                    ...valueRow('pivot', d.pivot, plain(numberText(transform.pivot, context))),
                )
            else
                rows.push(
                    ...valueRow(
                        'factor',
                        t.commands.scaleSelection.factor,
                        plain(d.composedTransform),
                    ),
                )
            retained(operation.data)
            break
        }
        case 'nse.header.set':
            rows.push(
                ...(operation.data.field === 'initialLife'
                    ? numberChange(
                          'life',
                          t.commands.properties.modal.life,
                          operation.data.before,
                          operation.data.after,
                          context,
                      )
                    : numberChange(
                          'offset',
                          t.commands.bgm.modal.offset,
                          operation.data.before,
                          operation.data.after,
                          context,
                          3,
                      )),
            )
            break
        case 'nse.bgm.change': {
            const { file, offset } = operation.data
            const before = nameDetail(file.before, context, { file: true })
            const after = nameDetail(file.after, context, { file: true })
            rows.push(
                ...(sameText(before, after)
                    ? valueRow('file', t.commands.bgm.modal.file, after)
                    : changeRow('file', t.commands.bgm.modal.file, before, after)),
            )
            if (offset)
                rows.push(
                    ...numberChange(
                        'offset',
                        t.commands.bgm.modal.offset,
                        offset.before,
                        offset.after,
                        context,
                        3,
                    ),
                )
            break
        }
        case 'nse.levelInfo.set': {
            const fields = t.historyChanges.fields
            const labels = {
                title: fields.title,
                artists: fields.artists,
                author: fields.author,
                description: fields.description,
                rating: fields.rating,
                tags: fields.tags,
                cover: fields.cover,
                preview: fields.previewAudio,
                initialLife: t.commands.properties.modal.life,
            } as const
            const rating = (value: number | null) =>
                value === null
                    ? placeholder(t.historyChanges.notSet)
                    : plain(numberText(value, context))
            for (const change of operation.data.changes) {
                const label = labels[change.field]
                switch (change.field) {
                    case 'initialLife':
                        rows.push(
                            ...numberChange(
                                change.field,
                                label,
                                change.before,
                                change.after,
                                context,
                            ),
                        )
                        break
                    case 'rating':
                        rows.push(
                            ...changeRow(
                                change.field,
                                label,
                                rating(change.before),
                                rating(change.after),
                            ),
                        )
                        break
                    case 'tags':
                        if (change.added)
                            rows.push(
                                ...valueRow(
                                    'tagsAdded',
                                    `${label}: ${t.historyChanges.added}`,
                                    plain(numberText(change.added, context)),
                                ),
                            )
                        if (change.removed)
                            rows.push(
                                ...valueRow(
                                    'tagsRemoved',
                                    `${label}: ${t.historyChanges.removed}`,
                                    plain(numberText(change.removed, context)),
                                ),
                            )
                        break
                    case 'title':
                    case 'artists':
                    case 'author':
                    case 'description':
                    case 'cover':
                    case 'preview':
                        rows.push(
                            ...changeRow(
                                change.field,
                                label,
                                nameDetail(change.before, context),
                                nameDetail(change.after, context),
                            ),
                        )
                }
            }
            break
        }
        case 'nse.dynamicStages.enable':
            rows.push(
                ...countsRow(
                    'created',
                    t.historyChanges.added,
                    countItems(operation.data.created, context),
                ),
            )
            break
        case 'nse.owner.create':
            if (operation.data.destination)
                rows.push(
                    ...valueRow(
                        'folder',
                        t.historyChanges.folder,
                        nameDetail(operation.data.destination.name, context),
                    ),
                )
            break
        case 'nse.owner.set':
            for (const change of operation.data.changes)
                rows.push(
                    ...changeRow(
                        change.field,
                        ownerFieldLabel(change.field, context),
                        ownerValue(change.before, context),
                        ownerValue(change.after, context),
                    ),
                )
            break
        case 'nse.owner.move': {
            const { category, fromIndex, toIndex } = operation.data
            if (category === 'reorder' && fromIndex !== undefined && toIndex !== undefined)
                rows.push(
                    ...numberChange(
                        'order',
                        t.historyChanges.order,
                        fromIndex + 1,
                        toIndex + 1,
                        context,
                    ),
                )
            break
        }
        case 'nse.owner.duplicate': {
            const { source, created, objects } = operation.data
            const titled = !source || total(created) === 0 || namesEntry(source, created)
            if (objects || !titled)
                rows.push(
                    ...countsRow('added', t.historyChanges.added, [
                        ...countItems(created, context),
                        ...countItems(objects ?? {}, context),
                    ]),
                )
            break
        }
        case 'nse.owner.delete': {
            const { target, removed, objects, replacement } = operation.data
            const titled = !target || total(removed) === 0 || namesEntry(target, removed)
            if (objects || !titled)
                rows.push(
                    ...countsRow('removed', t.historyChanges.removed, [
                        ...countItems(removed, context),
                        ...countItems(objects ?? {}, context),
                    ]),
                )
            if (replacement) facts.push(namedOwnerDescription('added', replacement, context))
            break
        }
        case 'nse.owner.ungroup':
            if (operation.data.released)
                rows.push(
                    ...countsRow(
                        'released',
                        d.released,
                        countItems(
                            {
                                [operation.data.target.kind === 'groupFolder' ? 'group' : 'stage']:
                                    operation.data.released,
                            },
                            context,
                        ),
                    ),
                )
            break
        case 'nse.file.export':
            if (operation.data.delivery === 'download')
                facts.push(message(context, t.entry.downloaded, nameText(operation.data.file)))
            break
        case 'nse.recovery':
            if (operation.data.droppedSteps)
                facts.push(message(context, d.droppedSteps, operation.data.droppedSteps))
            break
        default: {
            const exhaustive: never = operation
            throw new Error(`Missing operation Details: ${String(exhaustive)}`)
        }
    }
    return { rows, facts }
}

/** A step recorded by a newer editor, or one this editor cannot read. */
const unreadable = (raw: JsonValue, context: OperationTextContext): string => {
    const d = context.strings.history.details
    if (
        isObject(raw) &&
        typeof raw.id === 'string' &&
        (owns(operationCodecs, raw.id)
            ? typeof raw.version === 'number' && raw.version > 1
            : raw.id.startsWith('nse.'))
    )
        return d.newer
    return d.unsupported
}

const memberRecord = (member: OperationMember, context: OperationTextContext) => {
    const raw = memberOperation(member)
    const decoded = decodeOperation(raw)
    if (decoded.status === 'known') {
        const record = nativeRecord(decoded.operation, context)
        return {
            ...record,
            facts: hasShortenedName(decoded.operation.data)
                ? [...record.facts, context.strings.history.details.nameShortened]
                : record.facts,
        }
    }
    return {
        rows: [],
        facts: [],
        note: unreadable(raw, context),
        ...(decoded.fallback?.text && decoded.fallback.locale !== context.locale
            ? { lang: decoded.fallback.locale }
            : {}),
    } satisfies RecordData
}

const memberRecovery = (member: OperationMember) => {
    const recovery = memberRecoveryContext(member)
    return recovery
        ? {
              descriptions: Object.freeze([
                  ...recovery.dropped.slice(0, recovery.headIndex),
                  recovery.head,
                  ...recovery.dropped.slice(recovery.headIndex),
              ]),
              headIndex: recovery.headIndex,
              omitted: recovery.omitted,
          }
        : undefined
}

/** Net rows of a group: the first step's before and the last step's after. */
const groupRows = (recipe: OperationRecipe, context: OperationTextContext): DetailRow[] => {
    const t = context.strings
    const group = recipe.group
    if (!group) return []
    const operations = recipe.members.flatMap((member) => {
        const decoded = decodeOperation(memberOperation(member))
        return decoded.status === 'known' ? [decoded.operation] : []
    })
    const first = operations[0]
    const last = operations.at(-1)
    if (!first || !last) return []
    const rows: DetailRow[] = []
    if (
        (group.family === 'delete' || group.family === 'cut') &&
        group.subject === 'objects' &&
        recipe.metric
    )
        rows.push(
            ...countsRow(
                'removed',
                t.historyChanges.removed,
                countItems(recipe.metric.counts, context),
            ),
        )
    // Owners deleted or copied carry the chart objects that went with them, and a default entry
    // made when the last one went. The title counts only the owners; the cascade is shown here.
    if (group.family === 'ownerDelete' || group.family === 'ownerDuplicate') {
        const deleted = group.family === 'ownerDelete'
        const objects: Record<string, number> = {}
        let overflow = false
        for (const operation of operations) {
            if (operation.id !== 'nse.owner.delete' && operation.id !== 'nse.owner.duplicate')
                continue
            for (const [kind, value] of Object.entries(operation.data.objects ?? {})) {
                const sum = checkedSum([objects[kind] ?? 0, value])
                if (sum === undefined) overflow = true
                else objects[kind] = sum
            }
        }
        // The owners' own total is the title's; it is repeated only beside objects to add to.
        if (!overflow && recipe.metric && Object.keys(objects).length)
            rows.push(
                ...countsRow(
                    deleted ? 'removed' : 'added',
                    deleted ? t.historyChanges.removed : t.historyChanges.added,
                    [...countItems(recipe.metric.counts, context), ...countItems(objects, context)],
                ),
            )
        if (deleted) {
            const replacements: Record<string, number> = {}
            for (const operation of operations)
                if (operation.id === 'nse.owner.delete' && operation.data.replacement) {
                    const { kind } = operation.data.replacement
                    replacements[kind] = (replacements[kind] ?? 0) + 1
                }
            rows.push(
                ...countsRow('added', t.historyChanges.added, countItems(replacements, context)),
            )
        }
    }
    if (first.id === 'nse.header.set' && last.id === 'nse.header.set') {
        const offset = first.data.field === 'bgmOffset'
        rows.push(
            ...numberChange(
                offset ? 'offset' : 'life',
                offset ? t.commands.bgm.modal.offset : t.commands.properties.modal.life,
                first.data.before,
                last.data.after,
                context,
                offset ? 3 : 0,
            ),
        )
    } else if (first.id === 'nse.owner.set' && last.id === 'nse.owner.set') {
        for (const change of last.data.changes) {
            const start = first.data.changes.find(({ field }) => field === change.field)
            if (start)
                rows.push(
                    ...changeRow(
                        change.field,
                        ownerFieldLabel(change.field, context),
                        ownerValue(start.before, context),
                        ownerValue(change.after, context),
                    ),
                )
        }
    } else if (first.id === 'nse.owner.move' && last.id === 'nse.owner.move') {
        const { fromIndex } = first.data
        const { toIndex } = last.data
        if (group.category === 'reorder' && fromIndex !== undefined && toIndex !== undefined)
            rows.push(
                ...numberChange(
                    'order',
                    t.historyChanges.order,
                    fromIndex + 1,
                    toIndex + 1,
                    context,
                ),
            )
    }
    return rows
}

export const operationDetails = (
    recipe: OperationRecipe,
    context: OperationTextContext,
): OperationDetails => {
    const description = renderOperationRecipe(recipe, context)
    if (recipe.kind !== 'single') {
        const prefixless = recipe.kind === 'undo' || recipe.kind === 'redo'
        const summary = recipe.summary
        const shortened =
            hasShortenedName(summary?.data) ||
            hasShortenedName(recipe.group?.target) ||
            hasShortenedName(recipe.group?.destination)
        const steps: DetailStep[] = [...recipe.members].reverse().map((member) => {
            const record = memberRecord(member, context)
            return {
                member,
                label: describeMember(member, context, { prefixless }),
                expandable:
                    record.rows.length > 0 ||
                    record.facts.length > 0 ||
                    !!record.note ||
                    !!memberRecoveryContext(member),
            }
        })
        return {
            description,
            rows: groupRows(recipe, context),
            facts: shortened ? [context.strings.history.details.nameShortened] : [],
            steps: {
                count: recipe.members.length,
                partial: recipe.partial,
                members: steps,
                ...(prefixless ? { prefixless: true as const } : {}),
            },
        }
    }
    const member = recipe.members[0]
    if (!member) throw new Error('Missing Details member')
    const record = memberRecord(member, context)
    const recovery = memberRecovery(member)
    return {
        description,
        ...(record.lang ? { descriptionLang: record.lang } : {}),
        ...(record.note ? { note: record.note } : {}),
        rows: record.rows,
        facts: record.facts,
        ...(recovery ? { recovery } : {}),
    }
}
