import {
    checkedSum,
    subjectOfCounts,
    type FieldId,
    type NativeCounts,
    type OwnerCounts,
    type OwnerReference,
    type Subject,
} from './fields'
import type { NativeOperationInput, OwnerChange } from './registry'

export type AdditiveMetric =
    | { readonly unit: 'native'; readonly counts: NativeCounts }
    | { readonly unit: 'owner'; readonly counts: OwnerCounts }

export type GroupDescriptor = {
    readonly key: string
    readonly family:
        | 'add'
        | 'generate'
        | 'edit'
        | 'move'
        | 'resize'
        | 'replace'
        | 'elevation'
        | 'paste'
        | 'brush'
        | 'delete'
        | 'cut'
        | 'flip'
        | 'scale'
        | 'combine'
        | 'split'
        | 'vertical'
        | 'property'
        | 'header'
        | 'ownerCreate'
        | 'ownerRename'
        | 'ownerSet'
        | 'ownerMove'
        | 'ownerDuplicate'
        | 'ownerDelete'
    readonly subject?: Subject
    readonly axis?: 'horizontal' | 'vertical' | 'beats' | 'width' | 'elevation'
    readonly field?: FieldId | 'initialLife' | 'bgmOffset'
    readonly fields?: readonly OwnerChange['field'][]
    readonly target?: OwnerReference
    readonly destination?: OwnerReference | null
    readonly category?: 'reorder' | 'intoFolder' | 'outOfFolder'
    readonly metric?: AdditiveMetric
}

const anyCount = (counts: NativeCounts | OwnerCounts) =>
    Object.values(counts).some((value) => value > 0)
/** Whether a step changed anything: a total above zero (an unsafe total still counts). */
const anyChanged = (counts: NativeCounts) => (checkedSum(Object.values(counts)) ?? 1) > 0
const ownerKey = (target: OwnerReference) => [target.kind, target.id]
const group = (
    descriptor: Omit<GroupDescriptor, 'key'>,
    identity: readonly unknown[] = [],
): GroupDescriptor =>
    Object.freeze({
        ...descriptor,
        key: JSON.stringify([
            descriptor.family,
            descriptor.subject,
            descriptor.axis,
            descriptor.field,
            ...identity,
        ]),
    })

// This describes semantic membership only; chronology, availability and pins remain separate gates.
export const operationGroup = (operation: NativeOperationInput): GroupDescriptor | undefined => {
    switch (operation.id) {
        case 'nse.note.add':
        case 'nse.note.generate':
            return operation.data.created
                ? group({
                      family: operation.id === 'nse.note.add' ? 'add' : 'generate',
                      subject: 'note',
                      metric: { unit: 'native', counts: { note: operation.data.created } },
                  })
                : undefined
        case 'nse.object.add': {
            const { subject, created } = operation.data
            return created
                ? group({
                      family: 'add',
                      subject,
                      metric: { unit: 'native', counts: { [subject]: created } },
                  })
                : undefined
        }
        case 'nse.object.edit':
        case 'nse.object.move':
        case 'nse.object.replace':
            return anyChanged(operation.data.changed)
                ? group({
                      family:
                          operation.id === 'nse.object.edit'
                              ? 'edit'
                              : operation.id === 'nse.object.move'
                                ? 'resized' in operation.data
                                    ? 'resize'
                                    : 'move'
                                : 'replace',
                      subject: operation.data.subject,
                  })
                : undefined
        case 'nse.note.elevation':
            return operation.data.targets
                ? group({ family: 'elevation', subject: 'note' })
                : undefined
        case 'nse.object.paste':
            return anyCount(operation.data.placed)
                ? group({ family: 'paste', subject: 'objects' })
                : undefined
        case 'nse.object.brush':
            return anyChanged(operation.data.changed)
                ? group({ family: 'brush', subject: operation.data.subject })
                : undefined
        case 'nse.object.delete':
        case 'nse.object.cut':
            return anyCount(operation.data.removed)
                ? group({
                      family: operation.id === 'nse.object.delete' ? 'delete' : 'cut',
                      subject: subjectOfCounts(operation.data.removed),
                      metric: { unit: 'native', counts: operation.data.removed },
                  })
                : undefined
        case 'nse.object.flip':
        case 'nse.object.scale':
            return anyChanged(operation.data.changed)
                ? group({
                      family: operation.id === 'nse.object.flip' ? 'flip' : 'scale',
                      axis: operation.data.axis,
                  })
                : undefined
        case 'nse.note.combine':
            return operation.data.targets
                ? group({ family: 'combine', subject: 'note' })
                : undefined
        case 'nse.note.split':
            return operation.data.targets ? group({ family: 'split', subject: 'note' }) : undefined
        case 'nse.note.vertical':
            return operation.data.targets
                ? group({ family: 'vertical', subject: 'note' })
                : undefined
        case 'nse.property.set': {
            const { subject, changed, assignments } = operation.data
            if (!anyChanged(changed)) return
            return assignments.length === 1
                ? group({ family: 'property', subject, field: assignments[0]?.field })
                : group({ family: 'edit', subject })
        }
        case 'nse.header.set':
            return operation.data.before !== operation.data.after
                ? group({ family: 'header', field: operation.data.field })
                : undefined
        case 'nse.owner.create': {
            const { target, gathered } = operation.data
            if (gathered) return
            return group(
                { family: 'ownerCreate', metric: { unit: 'owner', counts: { [target.kind]: 1 } } },
                [target.kind],
            )
        }
        case 'nse.owner.rename':
            return group(
                { family: 'ownerRename', target: operation.data.target },
                ownerKey(operation.data.target),
            )
        case 'nse.owner.set': {
            const fields = operation.data.changes.map(({ field }) => field)
            return group({ family: 'ownerSet', target: operation.data.target, fields }, [
                ...ownerKey(operation.data.target),
                fields,
            ])
        }
        case 'nse.owner.move': {
            const { target, destination, category } = operation.data
            return group({ family: 'ownerMove', target, destination, category }, [
                ...ownerKey(target),
                category,
                destination ? ownerKey(destination) : null,
            ])
        }
        case 'nse.owner.duplicate':
        case 'nse.owner.delete': {
            const counts =
                operation.id === 'nse.owner.duplicate'
                    ? operation.data.created
                    : operation.data.removed
            if (!anyCount(counts)) return
            const kinds = Object.keys(counts)
                .filter((key) => (counts[key as keyof OwnerCounts] ?? 0) > 0)
                .sort()
            return group(
                {
                    family:
                        operation.id === 'nse.owner.duplicate' ? 'ownerDuplicate' : 'ownerDelete',
                    metric: { unit: 'owner', counts },
                },
                [operation.data.domain, kinds],
            )
        }
        case 'nse.bgm.change':
        case 'nse.levelInfo.set':
        case 'nse.dynamicStages.enable':
        case 'nse.owner.moveMany':
        case 'nse.owner.ungroup':
        case 'nse.origin':
        case 'nse.continue':
        case 'nse.file.save':
        case 'nse.file.export':
        case 'nse.restore':
        case 'nse.recovery':
        case 'nse.externalChange':
            return
    }
}
