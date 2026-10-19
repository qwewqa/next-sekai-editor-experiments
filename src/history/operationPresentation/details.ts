import {
    decodeOperation,
    type NameText,
    type NativeCounts,
    type NativeKind,
    type NativeOperationInput,
    type OwnerCounts,
    type OwnerKind,
    type OwnerReference,
    type Subject,
} from '../operations'
import { renderOperationRecipe } from './aggregate'
import { operationTime } from './format'
import { memberOperation, memberRecoveryContext } from './members'
import type {
    OperationDetailRow,
    OperationDetails,
    OperationDetailSection,
    OperationRecipe,
    OperationTextContext,
} from './types'
import {
    booleanText,
    message,
    nameText,
    numberText,
    operationFieldLabel,
    operationValueText,
    ownerFieldLabel,
    ownerValueText,
} from './values'

const nativeLabel = (kind: NativeKind, context: OperationTextContext) => {
    const t = context.strings
    if (kind === 'note') return t.tools.brush.kinds.note
    if (kind === 'bpm') return t.tools.bpm.title
    if (kind === 'timeScale') return t.tools.timeScale.title
    return t.events[kind]
}

const ownerLabel = (kind: OwnerKind, context: OperationTextContext) => {
    const t = context.strings
    return {
        group: t.modals.form.group.label,
        stage: t.modals.form.stage.label,
        groupFolder: t.historyChanges.groupFolders,
        stageFolder: t.historyChanges.stageFolders,
    }[kind]
}

const capturedNameRow = (
    key: string,
    label: string,
    name: NameText | null,
    context: OperationTextContext,
): OperationDetailRow => ({
    key,
    label,
    value: name === null ? context.strings.historyChanges.notPresent : nameText(name),
    ...(name?.truncated ? { nameShortened: true } : {}),
})

const countRows = (
    counts: NativeCounts | OwnerCounts,
    context: OperationTextContext,
): OperationDetailRow[] =>
    Object.entries(counts).map(([kind, value]) => ({
        key: kind,
        label: ['group', 'stage', 'groupFolder', 'stageFolder'].includes(kind)
            ? ownerLabel(kind as OwnerKind, context)
            : nativeLabel(kind as NativeKind, context),
        value: numberText(value, context),
    }))

const nativeSections = (operation: NativeOperationInput, context: OperationTextContext) => {
    const t = context.strings
    const sections: OperationDetailSection[] = []
    const add = (key: string, label: string, rows: readonly OperationDetailRow[]) =>
        sections.push({ key, label, rows })
    const row = (key: string, label: string, value: string): OperationDetailRow => ({
        key,
        label,
        value,
    })
    const counts = (key: string, label: string, values: NativeCounts | OwnerCounts) =>
        add(key, label, countRows(values, context))
    const principal = (subject: Subject, count: number, label = t.history.details.changed) =>
        subject === 'objects'
            ? add('principal', label, [
                  row('objects', label, message(context, t.workspace.manager.objects, count)),
              ])
            : counts('principal', label, { [subject]: count })
    const owner = (
        target: OwnerReference,
        key = 'target',
        label = ownerLabel(target.kind, context),
    ) => add(key, label, [capturedNameRow(key, t.modals.form.name.label, target.name, context)])
    const destination = (target: OwnerReference | null) =>
        target
            ? owner(target, 'destination', t.history.details.destination)
            : add('destination', t.history.details.destination, [
                  row('root', t.historyChanges.folder, t.workspace.folders.none),
              ])
    const numericChange = (key: string, label: string, before: number, after: number, shift = 0) =>
        add(key, label, [
            row('before', t.historyChanges.before, numberText(before, context, shift)),
            row('after', t.historyChanges.after, numberText(after, context, shift)),
        ])
    const collateral = (data: { displaced?: NativeCounts; retainedInitialBpm?: true }) => {
        if (data.displaced) counts('displaced', t.history.details.displaced, data.displaced)
        if (data.retainedInitialBpm)
            add('retained', t.tools.bpm.title, [
                row('initial', t.history.details.retainedInitialBpm, booleanText(true, context)),
            ])
    }
    const source = (name: NameText | undefined) => {
        if (name)
            add('source', t.history.details.source, [
                capturedNameRow('source', t.modals.form.name.label, name, context),
            ])
    }
    switch (operation.id) {
        case 'nse.note.add':
        case 'nse.note.generate':
            counts('created', t.historyChanges.added, { note: operation.data.created })
            break
        case 'nse.object.add':
            counts('created', t.historyChanges.added, {
                [operation.data.subject]: operation.data.created,
            })
            collateral(operation.data)
            break
        case 'nse.object.edit':
        case 'nse.object.move':
        case 'nse.object.replace':
            principal(operation.data.subject, operation.data.targets)
            collateral(operation.data)
            break
        case 'nse.note.elevation':
        case 'nse.note.vertical':
            principal('note', operation.data.targets)
            break
        case 'nse.object.paste':
            counts('placed', t.history.details.placed, operation.data.placed)
            counts('displaced', t.history.details.displaced, operation.data.displaced)
            add('paste', t.commands.paste.title, [
                row(
                    'layout',
                    t.sidebars.view.layout.label,
                    t.sidebars.view.layout[operation.data.variant],
                ),
                row(
                    'flipped',
                    t.history.details.flipped,
                    booleanText(operation.data.flipped, context),
                ),
                row(
                    'at',
                    t.history.details.pasteLocation,
                    t.history.details[operation.data.at === 'pointer' ? 'pointer' : 'position'],
                ),
            ])
            break
        case 'nse.object.brush':
        case 'nse.property.set':
            principal(operation.data.subject, operation.data.targets)
            add(
                'properties',
                t.workspace.panels.properties,
                operation.data.assignments.map((assignment) => {
                    const value = assignment.value
                    return {
                        key: assignment.field,
                        label: operationFieldLabel(assignment.field, context),
                        value:
                            value.mode === 'varying'
                                ? t.history.details.varying
                                : typeof value.value === 'object'
                                  ? nameText(value.value.name)
                                  : operationValueText(assignment.field, value.value, context),
                        ...(value.mode === 'uniform' &&
                        typeof value.value === 'object' &&
                        value.value.name.truncated
                            ? { nameShortened: true }
                            : {}),
                    }
                }),
            )
            break
        case 'nse.object.delete':
        case 'nse.object.cut':
            counts('removed', t.historyChanges.removed, operation.data.removed)
            break
        case 'nse.object.flip':
            principal(operation.data.subject, operation.data.targets)
            break
        case 'nse.object.scale':
            principal(operation.data.subject, operation.data.targets)
            add(
                'scale',
                t.commands.scaleSelection.factor,
                operation.data.transform.mode === 'uniform'
                    ? [
                          row(
                              'factor',
                              t.commands.scaleSelection.factor,
                              numberText(operation.data.transform.factor, context),
                          ),
                          row(
                              'pivot',
                              t.history.details.pivot,
                              numberText(operation.data.transform.pivot, context),
                          ),
                      ]
                    : [
                          row(
                              'composed',
                              t.history.details.composedTransform,
                              t.history.details.composedTransform,
                          ),
                      ],
            )
            break
        case 'nse.note.combine':
            principal('note', operation.data.notes)
            break
        case 'nse.note.split':
            add('split', t.commands.splitHold.title, [
                row(
                    'points',
                    t.commands.splitHold.title,
                    message(context, t.commands.splitHold.split, operation.data.points),
                ),
            ])
            break
        case 'nse.header.set':
            numericChange(
                'header',
                operation.data.field === 'initialLife'
                    ? t.commands.properties.modal.life
                    : t.commands.bgm.modal.offset,
                operation.data.before,
                operation.data.after,
                operation.data.field === 'bgmOffset' ? 3 : 0,
            )
            break
        case 'nse.bgm.change':
            add('file', t.commands.bgm.modal.file, [
                capturedNameRow(
                    'before',
                    t.historyChanges.before,
                    operation.data.file.before,
                    context,
                ),
                capturedNameRow(
                    'after',
                    t.historyChanges.after,
                    operation.data.file.after,
                    context,
                ),
            ])
            if (operation.data.offset)
                numericChange(
                    'offset',
                    t.commands.bgm.modal.offset,
                    operation.data.offset.before,
                    operation.data.offset.after,
                    3,
                )
            break
        case 'nse.dynamicStages.enable':
            add('dynamicStages', t.history.dynamicStages.title, [
                row('enabled', t.history.dynamicStages.title, booleanText(true, context)),
            ])
            break
        case 'nse.owner.create':
            owner(operation.data.target)
            counts('created', t.historyChanges.added, { [operation.data.target.kind]: 1 })
            destination(operation.data.destination)
            if (
                operation.data.target.kind === 'groupFolder' ||
                operation.data.target.kind === 'stageFolder'
            )
                counts('gathered', t.history.details.gathered, {
                    [operation.data.target.kind === 'groupFolder' ? 'group' : 'stage']:
                        operation.data.gathered,
                })
            break
        case 'nse.owner.rename':
            owner(operation.data.target)
            add('name', t.modals.form.name.label, [
                capturedNameRow('before', t.historyChanges.before, operation.data.before, context),
                capturedNameRow('after', t.historyChanges.after, operation.data.after, context),
            ])
            break
        case 'nse.owner.set':
            owner(operation.data.target)
            for (const change of operation.data.changes)
                add(change.field, ownerFieldLabel(change.field, context), [
                    row('before', t.historyChanges.before, ownerValueText(change.before, context)),
                    row('after', t.historyChanges.after, ownerValueText(change.after, context)),
                ])
            break
        case 'nse.owner.move':
            owner(operation.data.target)
            destination(operation.data.destination)
            if (operation.data.fromIndex !== undefined)
                add('fromIndex', t.historyChanges.order, [
                    row(
                        'from',
                        t.history.details.fromPosition,
                        numberText(operation.data.fromIndex, context),
                    ),
                ])
            if (operation.data.toIndex !== undefined)
                add('toIndex', t.historyChanges.order, [
                    row(
                        'to',
                        t.history.details.toPosition,
                        numberText(operation.data.toIndex, context),
                    ),
                ])
            break
        case 'nse.owner.moveMany':
            counts('principal', t.history.details.changed, {
                [operation.data.domain]: operation.data.targets,
            })
            destination(operation.data.destination)
            break
        case 'nse.owner.duplicate':
            if (operation.data.source)
                owner(operation.data.source, 'source', t.history.details.source)
            counts('created', t.historyChanges.added, operation.data.created)
            break
        case 'nse.owner.delete':
            if (operation.data.target) owner(operation.data.target)
            counts('removed', t.historyChanges.removed, operation.data.removed)
            break
        case 'nse.owner.ungroup':
            owner(operation.data.target)
            counts('released', t.history.details.released, {
                [operation.data.target.kind === 'groupFolder' ? 'group' : 'stage']:
                    operation.data.released,
            })
            break
        case 'nse.origin':
            source(operation.data.source)
            break
        case 'nse.continue':
            source(operation.data.source)
            add('fromTime', t.history.details.source, [
                row(
                    'time',
                    t.history.details.source,
                    operationTime(operation.data.fromTime, context),
                ),
            ])
            break
        case 'nse.file.save':
        case 'nse.file.export':
            add('file', t.commands.bgm.modal.file, [
                capturedNameRow('file', t.commands.bgm.modal.file, operation.data.file, context),
            ])
            add('delivery', t.history.details.delivery, [
                row(
                    'method',
                    t.history.details.delivery,
                    operation.data.delivery === 'file'
                        ? t.commands.bgm.modal.file
                        : t.history.details.download,
                ),
            ])
            break
        case 'nse.restore':
            source(operation.data.source)
            add('time', t.peek.restore, [
                row('time', t.peek.restore, operationTime(operation.data.targetTime, context)),
            ])
            break
        case 'nse.recovery':
            add('recovery', t.entry.recoveredChanges, [
                row(
                    'source',
                    t.history.details.source,
                    operation.data.source === 'journal'
                        ? t.history.details.unsavedChanges
                        : operation.data.source === 'autoSave'
                          ? t.history.details.autoSave
                          : t.settings.localData.title,
                ),
                row(
                    'dropped',
                    t.commands.undo.title,
                    message(context, t.history.details.droppedSteps, operation.data.droppedSteps),
                ),
            ])
            break
        case 'nse.externalChange':
            break
        default: {
            const exhaustive: never = operation
            throw new Error(`Missing operation Details: ${String(exhaustive)}`)
        }
    }
    return sections
}

export const operationDetails = (
    recipe: OperationRecipe,
    inputContext: OperationTextContext,
): OperationDetails => {
    const context = { ...inputContext, qualifiers: recipe.qualifiers }
    const description = renderOperationRecipe(recipe, context)
    const base = { description, stepCount: recipe.members.length, partial: recipe.partial }
    if (recipe.kind !== 'single') {
        const metric = recipe.metric
        return {
            ...base,
            sections: metric
                ? [
                      {
                          key: 'counts',
                          label:
                              recipe.group?.family === 'delete' ||
                              recipe.group?.family === 'ownerDelete' ||
                              recipe.group?.family === 'cut'
                                  ? context.strings.historyChanges.removed
                                  : context.strings.historyChanges.added,
                          rows: countRows(metric.counts, context),
                      },
                  ]
                : [],
            children: recipe.members,
        }
    }
    const member = recipe.members[0]
    if (!member) throw new Error('Missing Details member')
    const decoded = decodeOperation(memberOperation(member))
    const recovery = memberRecoveryContext(member)
    return {
        ...base,
        ...(decoded.status === 'unsupported'
            ? { explanation: context.strings.history.details.unsupported }
            : {}),
        sections: decoded.status === 'known' ? nativeSections(decoded.operation, context) : [],
        children: [],
        ...(recovery
            ? {
                  recovery: {
                      descriptions: Object.freeze([
                          ...recovery.dropped.slice(0, recovery.headIndex),
                          recovery.head,
                          ...recovery.dropped.slice(recovery.headIndex),
                      ]),
                      headIndex: recovery.headIndex,
                      omitted: recovery.omitted,
                  },
              }
            : {}),
    }
}
