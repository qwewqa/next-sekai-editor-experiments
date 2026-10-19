import {
    captureOperation,
    captureStep,
    createOperation,
    type JsonValue,
    type NativeOperationInput,
    type UndoableStep,
} from '../../src/history/operations'

// Explicit test descriptions are fixture data, never a native label parser.
export const nativeOperation = (input: NativeOperationInput, description: string) =>
    createOperation(input, { locale: 'en', describe: () => description })

export const initialLife = (before: number, after: number) =>
    nativeOperation(
        {
            id: 'nse.header.set',
            data: { field: 'initialLife', before, after },
        },
        `Set Initial Life to ${after}`,
    )

export const noteAdd = (created: number) =>
    nativeOperation(
        {
            id: 'nse.note.add',
            data: { created },
        },
        `Added ${created} notes`,
    )

export const originOperation = (origin: 'new' | 'import' | 'autoSave' | 'recovery' = 'new') =>
    nativeOperation({ id: 'nse.origin', data: { origin } }, `Origin: ${origin}`)

export const futureFixtureOperation = (
    caseId: string,
    data: JsonValue = {},
    fallback = caseId,
): JsonValue =>
    captureOperation({
        id: `test.future.${caseId}`,
        version: 1,
        data,
        fallback: { text: fallback, locale: 'en' },
    })

export const initialStep = (operation: JsonValue = originOperation()): UndoableStep =>
    captureStep({ kind: 'init', operation })

export const editStep = (operation: JsonValue): UndoableStep =>
    captureStep({ kind: 'edit', operation })

export const restoreStep = (targetTime: number): UndoableStep =>
    captureStep({
        kind: 'restore',
        operation: nativeOperation(
            { id: 'nse.restore', data: { targetTime } },
            `Restored ${targetTime}`,
        ),
    })

export const crossedEntry = (kind: 'undo' | 'redo', step: UndoableStep) => ({ kind, step })
