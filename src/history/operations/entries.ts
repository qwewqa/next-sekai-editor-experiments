import { isObject, OperationDataError, owns, type JsonValue } from './json'
import { captureOperation } from './registry'
import {
    captureRecoveryContext,
    captureStep,
    type RecoveryContext,
    type UndoableStep,
} from './steps'

export type StepEntryKind = 'edit' | 'restore' | 'undo' | 'redo'
export type EventEntryKind = 'init' | 'continue' | 'save' | 'export' | 'recovered'
export type HistoryEntryKind = StepEntryKind | EventEntryKind
export type EntryDescription =
    | { readonly kind: StepEntryKind; readonly step: UndoableStep; readonly operation?: never }
    | {
          readonly kind: Exclude<EventEntryKind, 'recovered'>
          readonly operation: JsonValue
          readonly step?: never
          readonly recoveryContext?: never
      }
    | {
          readonly kind: 'recovered'
          readonly operation: JsonValue
          readonly recoveryContext: RecoveryContext
          readonly step?: never
      }

export const captureEntryDescription = (value: unknown): EntryDescription => {
    if (!isObject(value) || !owns(value, 'kind')) throw new OperationDataError('Invalid entry kind')
    switch (value.kind) {
        case 'edit':
        case 'restore':
        case 'undo':
        case 'redo': {
            if (!owns(value, 'step') || owns(value, 'operation') || owns(value, 'recoveryContext'))
                throw new OperationDataError('Invalid step entry description')
            const step = captureStep(value.step)
            if ((value.kind === 'edit' || value.kind === 'restore') && step.kind !== value.kind)
                throw new OperationDataError('Entry and pushed step kinds disagree')
            if ((value.kind === 'undo' || value.kind === 'redo') && step.kind === 'init')
                throw new OperationDataError('Cannot cross an initial step')
            return Object.freeze({ kind: value.kind, step })
        }
        case 'init':
        case 'continue':
        case 'save':
        case 'export':
            if (!owns(value, 'operation') || owns(value, 'step') || owns(value, 'recoveryContext'))
                throw new OperationDataError('Invalid event description')
            return Object.freeze({ kind: value.kind, operation: captureOperation(value.operation) })
        case 'recovered':
            if (!owns(value, 'operation') || owns(value, 'step') || !owns(value, 'recoveryContext'))
                throw new OperationDataError('Invalid recovered entry description')
            return Object.freeze({
                kind: value.kind,
                operation: captureOperation(value.operation),
                recoveryContext: captureRecoveryContext(value.recoveryContext),
            })
        default:
            throw new OperationDataError('Invalid entry kind')
    }
}

export const entryOperation = (entry: EntryDescription): JsonValue =>
    entry.step ? entry.step.operation : entry.operation

export const pushedStep = (entry: EntryDescription): UndoableStep => {
    switch (entry.kind) {
        case 'edit':
        case 'restore':
            return entry.step
        case 'init':
        case 'continue':
            return captureStep({ kind: 'init', operation: entry.operation })
        default:
            throw new OperationDataError('Entry does not push a step')
    }
}
