import {
    captureEntryDescription,
    captureStep,
    entryOperation,
    type EntryDescription,
    type UndoableStep,
} from '../operations'
import type { OperationMember } from './types'

// Shared init descriptions use entry projection unless a bare step carries recovery context.
export const isEntryDescription = (
    description: EntryDescription | UndoableStep,
): description is EntryDescription =>
    'step' in description ||
    (description.kind === 'init' && !('recoveryContext' in description)) ||
    (description.kind !== 'init' && description.kind !== 'edit' && description.kind !== 'restore')

export const captureOperationMember = (member: OperationMember): OperationMember =>
    Object.freeze({
        description: isEntryDescription(member.description)
            ? captureEntryDescription(member.description)
            : captureStep(member.description),
        ...(member.time === undefined ? {} : { time: member.time }),
        ...(member.id === undefined ? {} : { id: member.id }),
    })

export const memberOperation = ({ description }: OperationMember) =>
    isEntryDescription(description) ? entryOperation(description) : description.operation

export const memberRecoveryContext = ({ description }: OperationMember) =>
    isEntryDescription(description)
        ? description.kind === 'recovered'
            ? description.recoveryContext
            : description.step?.recoveryContext
        : description.recoveryContext
