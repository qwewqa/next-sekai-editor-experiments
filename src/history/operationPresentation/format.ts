import { formatDateTimeSeconds } from '../../i18n/dateTime'
import {
    checkedSum,
    decodeOperation,
    subjectOfCounts,
    type EntryDescription,
    type JsonValue,
    type NativeCounts,
    type NativeOperationInput,
    type OwnerCounts,
    type OwnerKind,
    type OwnerReference,
    type PropertyData,
    type StepDescription,
    type Subject,
} from '../operations'
import { isEntryDescription } from './members'
import type { OperationMember, OperationTextContext } from './types'
import {
    joinSentences,
    message,
    nameText,
    numberText,
    operationFieldLabel,
    operationValueText,
    ownerFieldLabel,
    ownerName,
    ownerValueText,
} from './values'

export const subjectSuffix = (subject: Subject) => {
    if (subject === 'note') return 'Notes'
    if (subject === 'bpm') return 'Bpm'
    if (subject === 'timeScale') return 'TimeScales'
    if (subject === 'objects') return 'Objects'
    return 'Events'
}

export const eventSubtype = (subject: Subject, context: OperationTextContext) =>
    subject === 'objects' || subject === 'note' || subject === 'bpm' || subject === 'timeScale'
        ? ''
        : context.strings.eventKinds[subject]

export const nativeDescription = (
    action: 'added' | 'edited' | 'moved' | 'replaced',
    subject: Subject,
    count: number | undefined,
    context: OperationTextContext,
) => {
    const t = context.strings
    if (count === undefined) {
        if (action === 'replaced') {
            if (subject === 'bpm') return t.history.summary.replacedBpm
            if (subject === 'timeScale') return t.history.summary.replacedTimeScales
            throw new Error('Unsupported replacement subject')
        }
        if (subject === 'objects') {
            if (action === 'edited') return t.history.summary.editedObjects
            if (action === 'moved') return t.history.summary.movedObjects
            throw new Error('Unsupported addition subject')
        }
        return message(
            context,
            t.history.summary[
                `${action}${subjectSuffix(subject) as 'Notes' | 'Bpm' | 'TimeScales' | 'Events'}`
            ],
            eventSubtype(subject, context),
        )
    }
    if (subject === 'objects') {
        if (action === 'edited') return message(context, t.sidebars.default.edited, count)
        if (action === 'moved') return message(context, t.tools.select.moved, count)
        throw new Error('Unsupported object action')
    }
    if (subject === 'bpm' || subject === 'timeScale')
        return message(context, t.tools[subject][action], count)
    if (action === 'replaced') throw new Error('Unsupported replacement subject')
    if (subject === 'note') return message(context, t.tools.note[action], count)
    return message(context, t.tools.events[action], count, eventSubtype(subject, context))
}

export const removalOrBrushDescription = (
    action: 'deleted' | 'cut' | 'brushed',
    subject: Subject,
    count: number | undefined,
    context: OperationTextContext,
) => {
    const t = context.strings
    const suffix = subjectSuffix(subject)
    if (count === undefined)
        return message(
            context,
            t.history.summary[`${action}${suffix}`],
            eventSubtype(subject, context),
        )
    if (suffix !== 'Objects')
        return message(
            context,
            t.history.operation[`${action}${suffix}`],
            count,
            eventSubtype(subject, context),
        )
    return message(
        context,
        action === 'cut'
            ? t.commands.cut.cut
            : action === 'brushed'
              ? t.tools.brush.brushed
              : t.contextMenu.deleted,
        count,
    )
}

/** How many objects a step changed; undefined when the total is unsafe. */
const changedTotal = (changed: NativeCounts) => checkedSum(Object.values(changed))

export const propertyDescription = (
    data: PropertyData,
    context: OperationTextContext,
    aggregate = false,
) => {
    if (data.assignments.length !== 1)
        return nativeDescription(
            'edited',
            data.subject,
            aggregate ? undefined : changedTotal(data.changed),
            context,
        )
    const assignment = data.assignments[0]
    if (!assignment) throw new Error('Missing property assignment')
    const field = operationFieldLabel(assignment.field, context)
    const suffix = subjectSuffix(data.subject)
    const subtype = eventSubtype(data.subject, context)
    if (assignment.after.mode === 'varying')
        return aggregate
            ? message(context, context.strings.history.summary[`setOn${suffix}`], field, subtype)
            : message(
                  context,
                  context.strings.history.operation[`changedOn${suffix}`],
                  changedTotal(data.changed) ?? 0,
                  field,
                  subtype,
              )
    const value = operationValueText(assignment.field, assignment.after.value, context)
    return aggregate
        ? message(
              context,
              context.strings.history.summary[`setValueOn${suffix}`],
              field,
              value,
              subtype,
          )
        : message(
              context,
              context.strings.history.operation[`setValueOn${suffix}`],
              changedTotal(data.changed) ?? 0,
              field,
              value,
              subtype,
          )
}

export const ownerSuffix = (kind: OwnerKind) =>
    (
        ({
            group: 'Groups',
            stage: 'Stages',
            groupFolder: 'GroupFolders',
            stageFolder: 'StageFolders',
        }) as const
    )[kind]

export const ownerCountsDescription = (
    action: 'added' | 'duplicated' | 'deleted',
    counts: OwnerCounts,
    domain: 'group' | 'stage',
    context: OperationTextContext,
    quantityFree = false,
) => {
    const folder = domain === 'group' ? 'groupFolder' : 'stageFolder'
    const owners = counts[domain] ?? 0
    const folders = counts[folder] ?? 0
    const t = context.strings.history
    if (owners > 0 && folders > 0 && action !== 'added') {
        const key = `${action}${domain === 'group' ? 'Groups' : 'Stages'}AndFolders` as const
        return quantityFree ? t.summary[key] : message(context, t.operation[key], owners, folders)
    }
    const kind = folders > 0 || (owners === 0 && folder in counts) ? folder : domain
    const key = `${action}${ownerSuffix(kind)}` as const
    return quantityFree ? t.summary[key] : message(context, t.operation[key], counts[kind] ?? 0)
}

export const ownerDomain = (target: OwnerReference) =>
    target.kind === 'group' || target.kind === 'groupFolder' ? 'group' : 'stage'

export const namedOwnerDescription = (
    action: 'added' | 'duplicated' | 'deleted' | 'moved',
    target: OwnerReference,
    context: OperationTextContext,
) => {
    const t = context.strings
    const name = ownerName(target, context)
    if (target.kind === 'groupFolder' || target.kind === 'stageFolder')
        return message(
            context,
            t.history.operation[
                `${action}Named${target.kind === 'groupFolder' ? 'GroupFolder' : 'StageFolder'}`
            ],
            name,
        )
    if (action === 'duplicated')
        return message(
            context,
            t.workspace[target.kind === 'group' ? 'groups' : 'stages'].duplicated,
            name,
        )
    return message(
        context,
        t.commands[target.kind === 'group' ? 'manageGroups' : 'manageStages'].modal[action],
        name,
    )
}

export const renameDescription = (
    data: Extract<NativeOperationInput, { id: 'nse.owner.rename' }>['data'],
    context: OperationTextContext,
    netZero = false,
) => {
    const t = context.strings
    const before = ownerName({ ...data.target, name: data.before }, context)
    const after = ownerName({ ...data.target, name: data.after }, context)
    const suffix = {
        group: 'Group',
        stage: 'Stage',
        groupFolder: 'GroupFolder',
        stageFolder: 'StageFolder',
    } as const
    if (netZero)
        return message(context, t.history.operation[`renamed${suffix[data.target.kind]}`], after)
    return message(
        context,
        data.target.kind === 'groupFolder' || data.target.kind === 'stageFolder'
            ? t.history.operation[`renamedTo${suffix[data.target.kind]}`]
            : t.workspace[data.target.kind === 'group' ? 'groups' : 'stages'].renamed,
        before,
        after,
    )
}

export const ownerSetDescription = (
    data: Extract<NativeOperationInput, { id: 'nse.owner.set' }>['data'],
    context: OperationTextContext,
) => {
    const t = context.strings
    const group = data.target.kind === 'group'
    const name = ownerName(data.target, context)
    return joinSentences(
        data.changes.map((change) => {
            const field = ownerFieldLabel(change.field, context)
            return change.after === null
                ? message(context, t.workspace.groups.propertyCleared, name, field)
                : message(
                      context,
                      t.workspace[group ? 'groups' : 'stages'].propertySet,
                      name,
                      field,
                      ownerValueText(change.after, context),
                  )
        }),
        context,
    )
}

export const operationTime = (time: number, context: OperationTextContext) =>
    Number.isNaN(new Date(time).getTime())
        ? numberText(time, context)
        : formatDateTimeSeconds(context.locale, time, context.now)

export const describeOperation = (
    operation: NativeOperationInput,
    context: OperationTextContext,
): string => {
    const t = context.strings
    switch (operation.id) {
        case 'nse.note.add':
            return message(context, t.tools.note.added, operation.data.created)
        case 'nse.note.generate':
            return message(context, t.tools.generateSlideNotes.generated, operation.data.created)
        case 'nse.object.add':
            return nativeDescription(
                'added',
                operation.data.subject,
                operation.data.created,
                context,
            )
        case 'nse.object.edit':
            return nativeDescription(
                'edited',
                operation.data.subject,
                changedTotal(operation.data.changed),
                context,
            )
        case 'nse.object.move':
            return nativeDescription(
                'moved',
                operation.data.subject,
                changedTotal(operation.data.changed),
                context,
            )
        case 'nse.object.replace':
            return nativeDescription(
                'replaced',
                operation.data.subject,
                changedTotal(operation.data.changed),
                context,
            )
        case 'nse.note.elevation':
            return message(context, t.elevation.changed, operation.data.targets)
        case 'nse.object.paste': {
            const count = checkedSum(Object.values(operation.data.placed))
            return count === undefined
                ? t.history.summary.pastedObjects
                : message(context, t.tools.paste.pasted, count)
        }
        case 'nse.object.brush':
            return removalOrBrushDescription(
                'brushed',
                operation.data.subject,
                changedTotal(operation.data.changed),
                context,
            )
        case 'nse.object.delete':
        case 'nse.object.cut': {
            const removed: NativeCounts = operation.data.removed
            return removalOrBrushDescription(
                operation.id === 'nse.object.delete' ? 'deleted' : 'cut',
                subjectOfCounts(removed),
                checkedSum(Object.values(removed)),
                context,
            )
        }
        case 'nse.object.flip':
            return message(
                context,
                operation.data.axis === 'horizontal'
                    ? t.commands.flip.flipped
                    : t.commands.flipVertical.flipped,
                changedTotal(operation.data.changed) ?? 0,
            )
        case 'nse.object.scale':
            return message(
                context,
                t.commands[
                    { beats: 'scaleBeat', width: 'scaleWidth', elevation: 'scaleElevation' }[
                        operation.data.axis
                    ] as 'scaleBeat' | 'scaleWidth' | 'scaleElevation'
                ].scaled,
                changedTotal(operation.data.changed) ?? 0,
            )
        case 'nse.note.combine':
            return message(context, t.commands.combineNotes.combined, operation.data.targets)
        case 'nse.note.split':
            return message(context, t.commands.splitHold.split, operation.data.targets)
        case 'nse.note.vertical':
            return message(context, t.commands.makeVertical.made, operation.data.targets)
        case 'nse.property.set':
            return propertyDescription(operation.data, context)
        case 'nse.header.set':
            return message(
                context,
                operation.data.field === 'initialLife'
                    ? t.commands.properties.lifeSet
                    : t.commands.bgm.offsetSet,
                numberText(
                    operation.data.after,
                    context,
                    operation.data.field === 'bgmOffset' ? 3 : 0,
                ),
            )
        case 'nse.bgm.change':
            return operation.data.offset ? t.commands.bgm.changed : t.commands.bgm.fileChanged
        case 'nse.dynamicStages.enable':
            return t.history.dynamicStages.enabled
        case 'nse.owner.create': {
            const { target, gathered } = operation.data
            return gathered && (target.kind === 'groupFolder' || target.kind === 'stageFolder')
                ? message(
                      context,
                      t.history.operation[
                          target.kind === 'groupFolder'
                              ? 'createdGroupFolderWith'
                              : 'createdStageFolderWith'
                      ],
                      gathered,
                      ownerName(target, context),
                  )
                : namedOwnerDescription('added', target, context)
        }
        case 'nse.owner.rename':
            return renameDescription(operation.data, context)
        case 'nse.owner.set':
            return ownerSetDescription(operation.data, context)
        case 'nse.owner.move': {
            const { target, category, destination } = operation.data
            if (category === 'reorder') return namedOwnerDescription('moved', target, context)
            const suffix = target.kind === 'group' ? 'Group' : 'Stage'
            return category === 'intoFolder' && destination
                ? message(
                      context,
                      t.history.operation[`moved${suffix}Into`],
                      ownerName(target, context),
                      ownerName(destination, context),
                  )
                : message(
                      context,
                      t.history.operation[`moved${suffix}Out`],
                      ownerName(target, context),
                  )
        }
        case 'nse.owner.moveMany': {
            const { domain, targets, destination } = operation.data
            const suffix = domain === 'group' ? 'Groups' : 'Stages'
            return destination
                ? message(
                      context,
                      t.history.operation[`moved${suffix}Into`],
                      targets,
                      ownerName(destination, context),
                  )
                : message(context, t.history.operation[`moved${suffix}Out`], targets)
        }
        case 'nse.owner.duplicate':
            return operation.data.source && checkedSum(Object.values(operation.data.created)) !== 0
                ? namedOwnerDescription('duplicated', operation.data.source, context)
                : ownerCountsDescription(
                      'duplicated',
                      operation.data.created,
                      operation.data.domain,
                      context,
                  )
        case 'nse.owner.delete':
            return operation.data.target && checkedSum(Object.values(operation.data.removed)) !== 0
                ? namedOwnerDescription('deleted', operation.data.target, context)
                : ownerCountsDescription(
                      'deleted',
                      operation.data.removed,
                      operation.data.domain,
                      context,
                  )
        case 'nse.owner.ungroup':
            return message(
                context,
                t.workspace.folders.ungrouped,
                ownerName(operation.data.target, context),
            )
        case 'nse.origin': {
            const { origin, source } = operation.data
            switch (origin) {
                case 'new':
                    return t.history.operation.newLevel
                case 'import':
                    return source
                        ? message(context, t.history.openedFile, nameText(source))
                        : t.history.operation.importedLevel
                case 'autoSave':
                    return t.entry.migrated
                case 'recovery':
                    return t.entry.recoveredChanges
            }
            break
        }
        case 'nse.continue':
            return message(
                context,
                t.history.continuedFrom,
                operationTime(operation.data.fromTime, context),
            )
        case 'nse.file.save':
            return message(
                context,
                operation.data.delivery === 'download' ? t.entry.downloaded : t.entry.saved,
                nameText(operation.data.file),
            )
        case 'nse.file.export':
            return message(context, t.entry.exported, nameText(operation.data.file))
        case 'nse.restore':
            return message(
                context,
                t.entry.restoredTo,
                operationTime(operation.data.targetTime, context),
            )
        case 'nse.recovery':
            return t.entry.recoveredChanges
        case 'nse.externalChange':
            return t.entry.changedOutside
    }
    const exhaustive: never = operation
    throw new Error(`Missing native operation renderer: ${String(exhaustive)}`)
}

export const describeCapturedOperation = (
    operation: JsonValue,
    kindLabel: string,
    context: OperationTextContext,
) => {
    const decoded = decodeOperation(operation)
    if (decoded.status === 'known') return describeOperation(decoded.operation, context)
    if (decoded.fallback) return decoded.fallback.text
    return kindLabel
}

export const describeStep = (step: StepDescription, context: OperationTextContext) =>
    describeCapturedOperation(
        step.operation,
        {
            init: context.strings.peek.initialState,
            edit: context.strings.history.summary.edit,
            restore: context.strings.peek.restore,
        }[step.kind],
        context,
    )

export const describeEntry = (entry: EntryDescription, context: OperationTextContext) => {
    const t = context.strings
    if (entry.step) {
        const description = describeStep(entry.step, context)
        return entry.kind === 'undo' || entry.kind === 'redo'
            ? `${t.commands[entry.kind].title} · ${description}`
            : description
    }
    return describeCapturedOperation(
        entry.operation,
        {
            init: t.peek.initialState,
            continue: t.entry.continued,
            save: t.commands.save.title,
            export: t.commands.exportLevel.title,
            recovered: t.entry.recoveredChanges,
        }[entry.kind],
        context,
    )
}

export const describeMember = ({ description }: OperationMember, context: OperationTextContext) =>
    isEntryDescription(description)
        ? describeEntry(description, context)
        : describeStep(description, context)
