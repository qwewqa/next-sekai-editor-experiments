import { count } from './codec'
import {
    captureJson,
    isObject,
    jsonBytes,
    OPERATION_WIRE_BYTES,
    OPERATION_WIRE_DEPTH,
    OperationDataError,
    owns,
    type JsonObject,
    type JsonValue,
} from './json'
import { captureOperation, decodeOperation } from './registry'

export const RECOVERY_CONTEXT_ITEMS = 64
export const RECOVERY_CONTEXT_BYTES = 128 * 1024

export type StepKind = 'init' | 'edit' | 'restore'

/**
 * `x`, the one ignorable extension carrier of a structural object (a step, a recovery-context
 * item, an undo slot, a stack): a JSON object within the operation byte limit. A reader carries it
 * by value wherever it copies the object whole, never reads it, and may drop it wherever it
 * rebuilds the object. Today's writers write none. Anything a reader must understand uses a version.
 */
export type Extension = JsonObject

export type StepDescription = {
    readonly kind: StepKind
    readonly operation: JsonValue
    readonly x?: Extension
}
export type RecoveryContext = {
    readonly head: StepDescription
    readonly headIndex: number
    readonly dropped: readonly StepDescription[]
    readonly omitted: number
    readonly x?: Extension
}
export type UndoableStep = StepDescription & { readonly recoveryContext?: RecoveryContext }
export type RecoverySources = RecoveryContext

/** The keys of each carrier: everything but `x` is v1's, and nothing else is read. */
const STEP_KEYS = ['kind', 'operation', 'x', 'recoveryContext'] as const
const ITEM_KEYS = ['kind', 'operation', 'x'] as const
const CONTEXT_KEYS = ['head', 'headIndex', 'dropped', 'omitted', 'x'] as const

const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
    Object.keys(value).every((key) => keys.includes(key))

/** An `x` is absent, or a JSON object within the operation byte limit. */
const extension = (value: Record<string, unknown>) =>
    !owns(value, 'x') ||
    (isObject(value.x) && jsonBytes(value.x as JsonObject) <= OPERATION_WIRE_BYTES)

const description = (value: unknown): value is StepDescription => {
    if (
        !isObject(value) ||
        !onlyKeys(value, ITEM_KEYS) ||
        !owns(value, 'kind') ||
        !owns(value, 'operation') ||
        !extension(value) ||
        !['init', 'edit', 'restore'].includes(value.kind as string)
    )
        return false
    captureOperation(value.operation)
    return true
}

const context = (value: unknown): value is RecoveryContext => {
    if (
        !isObject(value) ||
        !onlyKeys(value, CONTEXT_KEYS) ||
        !extension(value) ||
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
        !onlyKeys(captured, STEP_KEYS) ||
        !owns(captured, 'kind') ||
        !owns(captured, 'operation') ||
        !extension(captured) ||
        !description({ kind: captured.kind, operation: captured.operation }) ||
        (hasContext && !context(captured.recoveryContext))
    )
        throw new OperationDataError('Invalid History step')
    return captured as unknown as UndoableStep
}

/** A step's description: its `x` goes with it, since the description copies the step whole. */
export const stepDescription = (step: UndoableStep): StepDescription =>
    Object.freeze({
        kind: step.kind,
        operation: step.operation,
        ...(step.x === undefined ? {} : { x: step.x }),
    })

/**
 * A step, a recovery context or an entry's description with the keys that no carrier of v1 has
 * removed, and where they were (paths relative to the value). A reader reports those as
 * `unknown-key`, newer content, and checks the rest as it would any other: only `x` is ignorable
 * (§1.6.11.8). The value is not otherwise checked.
 */
export type Stripped = { value: unknown; unknown: string[] }

const strip = (value: unknown, keys: readonly string[], path: string, out: string[]) => {
    if (!isObject(value)) return value
    const kept: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
        if (keys.includes(key)) Object.defineProperty(kept, key, { value: item, enumerable: true })
        else out.push(`${path}${key}`)
    }
    return kept
}

const stripContext = (value: unknown, path: string, out: string[]) => {
    const kept = strip(value, CONTEXT_KEYS, path, out)
    if (!isObject(kept)) return kept
    const copy: Record<string, unknown> = { ...kept }
    if (owns(copy, 'head')) copy.head = strip(copy.head, ITEM_KEYS, `${path}head.`, out)
    if (Array.isArray(copy.dropped))
        copy.dropped = copy.dropped.map((item, i) =>
            strip(item, ITEM_KEYS, `${path}dropped[${i}].`, out),
        )
    return copy
}

export const stripUnknownStepKeys = (value: unknown, path = ''): Stripped => {
    const unknown: string[] = []
    const kept = strip(value, STEP_KEYS, path, unknown)
    if (isObject(kept) && owns(kept, 'recoveryContext'))
        return {
            value: {
                ...kept,
                recoveryContext: stripContext(
                    kept.recoveryContext,
                    `${path}recoveryContext.`,
                    unknown,
                ),
            },
            unknown,
        }
    return { value: kept, unknown }
}

/** The same for an entry's description: its `step`, or its `recoveryContext`. */
export const stripUnknownEntryKeys = (entry: Record<string, unknown>): Stripped => {
    const unknown: string[] = []
    const value: Record<string, unknown> = { ...entry }
    if (owns(entry, 'step')) {
        const step = stripUnknownStepKeys(entry.step, 'step.')
        value.step = step.value
        unknown.push(...step.unknown)
    }
    if (owns(entry, 'recoveryContext'))
        value.recoveryContext = stripContext(entry.recoveryContext, 'recoveryContext.', unknown)
    return { value, unknown }
}

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
