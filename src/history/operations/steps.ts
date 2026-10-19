import { count } from './codec'
import {
    captureJson,
    isObject,
    jsonBytes,
    OPERATION_WIRE_BYTES,
    OPERATION_WIRE_DEPTH,
    OperationDataError,
    owns,
    type JsonValue,
} from './json'
import { captureOperation, decodeOperation } from './registry'

export const RECOVERY_CONTEXT_ITEMS = 64
export const RECOVERY_CONTEXT_BYTES = 128 * 1024

export type StepKind = 'init' | 'edit' | 'restore'
export type StepDescription = { readonly kind: StepKind; readonly operation: JsonValue }
export type RecoveryContext = {
    readonly head: StepDescription
    readonly headIndex: number
    readonly dropped: readonly StepDescription[]
    readonly omitted: number
}
export type UndoableStep = StepDescription & { readonly recoveryContext?: RecoveryContext }
export type RecoverySources = RecoveryContext

const description = (value: unknown): value is StepDescription => {
    if (
        !isObject(value) ||
        Object.keys(value).length !== 2 ||
        !owns(value, 'kind') ||
        !owns(value, 'operation') ||
        !['init', 'edit', 'restore'].includes(value.kind as string)
    )
        return false
    captureOperation(value.operation)
    return true
}

const context = (value: unknown): value is RecoveryContext => {
    if (
        !isObject(value) ||
        Object.keys(value).length !== 4 ||
        !owns(value, 'head') ||
        !owns(value, 'headIndex') ||
        !owns(value, 'dropped') ||
        !owns(value, 'omitted') ||
        !description(value.head) ||
        !count.is(value.omitted) ||
        !Array.isArray(value.dropped) ||
        !count.is(value.headIndex) ||
        value.headIndex > value.dropped.length ||
        value.dropped.length > RECOVERY_CONTEXT_ITEMS ||
        value.omitted > Number.MAX_SAFE_INTEGER - value.dropped.length ||
        !value.dropped.every(description)
    )
        return false
    return jsonBytes(value.dropped) <= RECOVERY_CONTEXT_BYTES
}

export const captureRecoveryContext = (value: unknown): RecoveryContext => {
    const captured = captureJson(value, {
        bytes: OPERATION_WIRE_BYTES + RECOVERY_CONTEXT_BYTES + 2048,
        depth: OPERATION_WIRE_DEPTH + 3,
    })
    if (!context(captured)) throw new OperationDataError('Invalid recovery context')
    return captured
}

export const captureStep = (value: unknown): UndoableStep => {
    const captured = captureJson(value, {
        bytes: 2 * OPERATION_WIRE_BYTES + RECOVERY_CONTEXT_BYTES + 4096,
        depth: OPERATION_WIRE_DEPTH + 4,
    })
    if (!isObject(captured)) throw new OperationDataError('Invalid History step')
    const hasContext = owns(captured, 'recoveryContext')
    if (
        Object.keys(captured).length !== (hasContext ? 3 : 2) ||
        !owns(captured, 'kind') ||
        !owns(captured, 'operation') ||
        !description({ kind: captured.kind, operation: captured.operation }) ||
        (hasContext && !context(captured.recoveryContext))
    )
        throw new OperationDataError('Invalid History step')
    return captured as unknown as UndoableStep
}

export const stepDescription = (step: UndoableStep): StepDescription =>
    Object.freeze({ kind: step.kind, operation: step.operation })

export const isSyntheticRecovery = (step: StepDescription) => {
    const decoded = decodeOperation(step.operation)
    return (
        step.kind === 'edit' &&
        decoded.status === 'known' &&
        decoded.operation.id === 'nse.recovery'
    )
}

// The journal orders these source occurrences against other slots before applying the budget.
export const recoverySources = (input: UndoableStep): RecoverySources => {
    const head = captureStep(input)
    const previous = head.recoveryContext
    const flattened = previous && isSyntheticRecovery(head)
    const dropped = [...(previous?.dropped ?? [])]
    if (previous && !flattened) dropped.splice(previous.headIndex, 0, previous.head)
    return Object.freeze({
        head: flattened ? previous.head : stepDescription(head),
        headIndex: flattened ? previous.headIndex : dropped.length,
        dropped: Object.freeze(dropped),
        omitted: previous?.omitted ?? 0,
    })
}

// Callers flatten disjoint occurrences and order them oldest first, including any redo tail.
export const createRecoveryContext = (
    head: StepDescription,
    dropped: readonly StepDescription[],
    headIndex: number,
    omitted = 0,
): RecoveryContext => {
    if (!count.is(omitted)) throw new OperationDataError('Invalid omitted description count')
    if (!count.is(headIndex) || headIndex > dropped.length)
        throw new OperationDataError('Invalid recovery head position')
    const excess = Math.max(0, dropped.length - RECOVERY_CONTEXT_ITEMS)
    if (excess > Number.MAX_SAFE_INTEGER - omitted)
        throw new OperationDataError('Recovery count overflow')
    omitted += excess
    headIndex = Math.max(0, headIndex - excess)
    const optional = dropped.slice(excess).map((item) => {
        const captured = captureStep(item)
        if (captured.recoveryContext)
            throw new OperationDataError('Recovery sources must be flattened')
        return stepDescription(captured)
    })
    const sizes = optional.map((item) => jsonBytes(item as unknown as JsonValue))
    let bytes = 2 + sizes.reduce((sum, value) => sum + value, 0) + Math.max(0, sizes.length - 1)
    while (bytes > RECOVERY_CONTEXT_BYTES) {
        const size = sizes.shift()
        if (size === undefined) throw new OperationDataError('Invalid recovery budget')
        bytes -= size + (optional.length > 1 ? 1 : 0)
        optional.shift()
        headIndex = Math.max(0, headIndex - 1)
        if (omitted === Number.MAX_SAFE_INTEGER)
            throw new OperationDataError('Recovery count overflow')
        omitted++
    }
    const captured = captureStep({
        kind: 'edit',
        operation: null,
        recoveryContext: { head, headIndex, dropped: optional, omitted },
    })
    if (!captured.recoveryContext) throw new OperationDataError('Missing recovery context')
    return captured.recoveryContext
}
