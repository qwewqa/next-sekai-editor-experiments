import {
    captureOperation,
    checkedSum,
    decodeOperation,
    equalJson,
    operationGroup,
    type AdditiveMetric,
    type FieldId,
    type FieldValue,
    type GroupDescriptor,
    type NativeOperationInput,
    type OwnerCounts,
} from '../operations'
import {
    describeMember,
    describeOperation,
    nativeDescription,
    ownerCountsDescription,
    ownerDomain,
    ownerSetDescription,
    propertyDescription,
    removalOrBrushDescription,
    renameDescription,
    resizeDescription,
} from './format'
import { captureOperationMember, isEntryDescription, memberOperation } from './members'
import type { OperationMember, OperationRecipe, OperationTextContext } from './types'
import { joinFields, message, numberText, ownerFieldLabel, ownerName, quotedField } from './values'

export type OperationRecipeOptions = {
    readonly partial?: boolean
    readonly direction?: 'undo' | 'redo'
}

export const equalOperationValue = (a: FieldValue<FieldId>, b: FieldValue<FieldId>) =>
    typeof a === 'object' && typeof b === 'object'
        ? a.kind === b.kind && a.id === b.id
        : equalJson(a, b)

const knownOperation = (member: OperationMember) => {
    const decoded = decodeOperation(memberOperation(member))
    if (decoded.status !== 'known') throw new Error('Unsupported operation cannot be aggregated')
    return decoded.operation
}

const sumMetrics = (metrics: readonly AdditiveMetric[]) => {
    const first = metrics[0]
    if (!first) return {}
    const counts: Record<string, number> = {}
    for (const metric of metrics) {
        if (metric.unit !== first.unit) throw new Error('Mismatched operation count units')
        for (const [kind, value] of Object.entries(metric.counts)) {
            const sum = checkedSum([counts[kind] ?? 0, value])
            if (sum === undefined) return { overflow: true }
            counts[kind] = sum
        }
    }
    if (checkedSum(Object.values(counts)) === undefined) return { overflow: true }
    return {
        metric: Object.freeze({
            unit: first.unit,
            counts: Object.freeze(counts),
        }) as AdditiveMetric,
    }
}

// Members are oldest first; callers establish chronology, availability and pinned boundaries.
export const captureOperationRecipe = (
    input: readonly OperationMember[],
    options: OperationRecipeOptions = {},
): OperationRecipe => {
    if (!input.length) throw new Error('An operation recipe needs a member')
    const members = Object.freeze(input.map(captureOperationMember))
    const partial = options.partial ?? false
    const base = { members, partial }
    if (options.direction) {
        if (
            members.some(({ description }) =>
                isEntryDescription(description)
                    ? description.kind !== options.direction
                    : description.kind === 'init',
            )
        )
            throw new Error('Only matching crossed steps form direction groups')
        return Object.freeze({ ...base, kind: options.direction })
    }
    if (members.length === 1 && !partial) return Object.freeze({ ...base, kind: 'single' })
    const operations = members.map((member) => {
        if (member.description.kind !== 'edit') throw new Error('Only edits form operation groups')
        return knownOperation(member)
    })
    const first = operations[0]
    const last = operations.at(-1)
    if (!first || !last) throw new Error('Missing operation group member')
    const group = operationGroup(first)
    if (!group || operations.some((operation) => operationGroup(operation)?.key !== group.key))
        throw new Error('Incompatible operation group members')
    const metrics = operations.flatMap((operation) => {
        const metric = operationGroup(operation)?.metric
        return metric ? [metric] : []
    })
    let summary: NativeOperationInput = last
    let uniform: boolean | undefined
    if (
        first.id === 'nse.property.set' &&
        last.id === 'nse.property.set' &&
        group.family === 'property'
    ) {
        const assignment = last.data.assignments[0]
        if (!assignment) throw new Error('Missing grouped property')
        const value = assignment.after
        const same =
            value.mode === 'uniform' &&
            operations.every((operation) => {
                if (operation.id !== 'nse.property.set') return false
                const other = operation.data.assignments[0]?.after
                return other?.mode === 'uniform' && equalOperationValue(value.value, other.value)
            })
        summary = {
            ...last,
            data: {
                ...last.data,
                assignments: [
                    {
                        ...assignment,
                        before: first.data.assignments[0]?.before ?? assignment.before,
                        after: same ? value : { mode: 'varying' },
                    },
                ],
            },
        } as NativeOperationInput
    } else if (first.id === 'nse.owner.rename' && last.id === 'nse.owner.rename') {
        summary = { ...last, data: { ...last.data, before: first.data.before } }
    } else if (first.id === 'nse.owner.set' && last.id === 'nse.owner.set') {
        uniform = operations.every(
            (operation) =>
                operation.id === 'nse.owner.set' &&
                operation.data.changes.every((change, index) => {
                    const other = last.data.changes[index]
                    return other !== undefined && equalJson(change.after, other.after)
                }),
        )
    }
    return Object.freeze({
        ...base,
        kind: 'group',
        group: captureOperation(group) as unknown as GroupDescriptor,
        summary: captureOperation({
            id: summary.id,
            data: summary.data,
        }) as unknown as NativeOperationInput,
        ...(uniform === undefined ? {} : { uniform }),
        ...sumMetrics(metrics),
    })
}

const stepCountValue = (recipe: OperationRecipe, context: OperationTextContext) =>
    recipe.partial ? `${numberText(recipe.members.length, context)}+` : recipe.members.length

export const operationStepCount = (recipe: OperationRecipe, context: OperationTextContext) =>
    message(context, context.strings.history.steps, stepCountValue(recipe, context))

export const renderOperationRecipe = (
    recipe: OperationRecipe,
    context: OperationTextContext,
): string => {
    const t = context.strings
    const first = recipe.members[0]
    if (!first) throw new Error('Missing recipe member')
    if (recipe.kind === 'single') return describeMember(first, context)
    if (recipe.kind === 'undo' || recipe.kind === 'redo')
        return message(
            context,
            recipe.kind === 'undo' ? t.history.undidSteps : t.history.redidSteps,
            stepCountValue(recipe, context),
        )
    const group = recipe.group
    const summary = recipe.summary
    if (!group || !summary) throw new Error('Missing operation group summary')
    const subject = () => {
        if (!group.subject) throw new Error('Missing operation group subject')
        return group.subject
    }
    const count = recipe.metric ? checkedSum(Object.values(recipe.metric.counts)) : undefined
    switch (group.family) {
        case 'add':
            return nativeDescription('added', subject(), count, context)
        case 'generate':
            return count === undefined
                ? t.history.summary.generatedNotes
                : message(context, t.tools.generateSlideNotes.generated, count)
        case 'edit':
            return nativeDescription('edited', subject(), undefined, context)
        case 'move':
            return nativeDescription('moved', subject(), undefined, context)
        case 'resize':
            return resizeDescription(subject(), undefined, context)
        case 'replace':
            return nativeDescription('replaced', subject(), undefined, context)
        case 'elevation':
            return t.history.summary.changedNoteElevations
        case 'paste':
            return t.history.summary.pastedObjects
        case 'brush':
            return removalOrBrushDescription('brushed', subject(), undefined, context)
        case 'delete':
            return removalOrBrushDescription('deleted', subject(), count, context)
        case 'cut':
            return removalOrBrushDescription('cut', subject(), count, context)
        case 'flip':
            return group.axis === 'horizontal'
                ? t.history.summary.flippedHorizontally
                : t.history.summary.flippedVertically
        case 'scale':
            return t.history.summary[
                group.axis === 'beats'
                    ? 'scaledBeats'
                    : group.axis === 'width'
                      ? 'scaledWidth'
                      : 'scaledElevations'
            ]
        case 'combine':
            return t.history.summary.combinedNotes
        case 'split':
            return t.history.summary.splitSlideConnections
        case 'vertical':
            return t.history.summary.madeNotesVertical
        case 'property':
            if (summary.id !== 'nse.property.set') throw new Error('Missing property summary')
            return propertyDescription(summary.data, context, true)
        case 'header':
            return message(
                context,
                t.history.operation.changedHeader,
                group.field === 'initialLife'
                    ? quotedField(t.commands.properties.modal.life, context)
                    : quotedField(t.history.details.bgmOffset, context),
            )
        case 'ownerCreate':
        case 'ownerDuplicate':
        case 'ownerDelete': {
            const counts = (recipe.metric ?? group.metric)?.counts as OwnerCounts | undefined
            if (!counts) throw new Error('Missing owner metric')
            const domain = 'group' in counts || 'groupFolder' in counts ? 'group' : 'stage'
            return ownerCountsDescription(
                group.family === 'ownerCreate'
                    ? 'added'
                    : group.family === 'ownerDuplicate'
                      ? 'duplicated'
                      : 'deleted',
                counts,
                domain,
                context,
                !!recipe.overflow,
            )
        }
        case 'ownerRename': {
            if (summary.id !== 'nse.owner.rename') throw new Error('Missing rename summary')
            const { before, after } = summary.data
            return renameDescription(
                summary.data,
                context,
                !before.truncated && !after.truncated && before.text === after.text,
            )
        }
        case 'ownerSet': {
            if (summary.id !== 'nse.owner.set') throw new Error('Missing owner property summary')
            if (recipe.uniform) return ownerSetDescription(summary.data, context)
            return message(
                context,
                t.history.operation[
                    ownerDomain(summary.data.target) === 'group'
                        ? 'changedGroupProperties'
                        : 'changedStageProperties'
                ],
                ownerName(summary.data.target, context),
                joinFields(
                    summary.data.changes.map(({ field }) =>
                        ownerFieldLabel(field, context, { prose: true }),
                    ),
                    context,
                ),
            )
        }
        case 'ownerMove':
            return describeOperation(summary, context)
    }
}
