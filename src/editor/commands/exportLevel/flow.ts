import {
    diskStateOfBytes,
    FileError,
    platform,
    type DiskState,
    type FileTarget,
    type ReadyPrompt,
    type SavePickerType,
    type SaveResult,
} from '../../../platform'
import { isLevelDataContent, mayBeLevelData } from './content'
import { exportMemory, type ExportTarget } from './memory'
import { downloadOpened, refusePick, type RefusedPick } from './pick'

// Export Level Data…'s writes (Part 1 §1.4.8), apart from its dialogs, so Node tests can run them.

/** What a follow-up dialog answers; undefined is Cancel. */
export type ExportUi = {
    /** The conflict dialog's Export form; `opened` while the target is the opened file. */
    conflict: (
        name: string,
        disk: DiskState,
        opened: boolean,
    ) => Promise<'replace' | 'chooseAnother' | undefined>
    notLevelData: (name: string) => Promise<'chooseAnother' | undefined>
    /** A pick of level data whose import left parts out. */
    unsupportedParts: (name: string) => Promise<'chooseAnother' | undefined>
    /** A refused pick whose bytes could not be put back; `emptied` while it is empty. */
    notPutBack: (name: string, emptied: boolean) => Promise<'download' | undefined>
    notFound: (name: string) => Promise<'chooseAnother' | undefined>
    denied: (name: string) => Promise<'tryAgain' | 'chooseAnother' | undefined>
    failed: (name: string, error: FileError) => Promise<'chooseAnother' | undefined>
    exported: (name: string) => void
    downloadStarted: (name: string, size: number) => void
    /** Records the export in the session's timeline (Part 1 §1.3.8). */
    markExported?: (name: string) => void
}

export type ExportContext = {
    ui: ExportUi
    /** Builds the file; called before any picker, since a picker empties what it returns (D5). */
    build: () => Blob
    /** The name a picker suggests or a download takes. */
    suggestedName: string
    /** The picker's types: the `.nsld` type, or none for "All files" alone. */
    types: SavePickerType[]
    /** The name to remember on success, as typed. */
    exportName?: string
    /** Closes the Export dialog before a follow-up dialog shows. */
    leave: () => void
    ready?: ReadyPrompt
    /** Aborted when the dialog is cancelled: nothing more is written or shown. */
    signal?: AbortSignal
    /** Called once a picked file is accepted: its write runs to its end, cancel or not (D5). */
    committed?: () => void
}

/** done: written or handed over; cancelled: nothing written; back: the picker was dismissed. */
export type ExportOutcome = 'done' | 'cancelled' | 'back'

/** Above this, a file is not taken for level data without being read whole. */
const LEVEL_DATA_LIMIT = 64 * 1024 * 1024

const fileError = (error: unknown) => {
    if (error instanceof FileError) return error
    return new FileError('io', error instanceof Error ? error.message : String(error))
}

// Only the user's cancel: a browser's own AbortError is a failure.
const cancelled = (ctx: ExportContext) => !!ctx.signal?.aborted

const built = (ctx: ExportContext) => {
    let size = 0
    return {
        build: () => {
            const blob = ctx.build()
            size = blob.size
            return Promise.resolve(blob)
        },
        size: () => size,
    }
}

const remember = (ctx: ExportContext, target: ExportTarget) => {
    exportMemory.target = target
    if (ctx.exportName !== undefined) exportMemory.exportName = ctx.exportName
}

const saved = (ctx: ExportContext, result: SaveResult & { status: 'saved' }) => {
    if (result.target.kind !== 'handle' || !result.disk) throw new Error('Not a handle write')
    remember(ctx, {
        name: result.name,
        handle: result.target.handle,
        disk: result.disk,
        exported: true,
    })
    ctx.ui.markExported?.(result.name)
    ctx.ui.exported(result.name)
}

type Found =
    | { state: 'missing' }
    | { state: 'unreadable'; error: FileError }
    | { state: 'other' }
    | { state: 'levelData'; disk: DiskState }

/**
 * The target as one read finds it, so its disk state and its content check describe the same
 * bytes (Part 0 §0.9.1, the pinned source).
 */
const readTarget = async (target: FileTarget): Promise<Found> => {
    try {
        const file = await platform.read(target)
        const [first] = new Uint8Array(await file.slice(0, 1).arrayBuffer())
        if (file.size > LEVEL_DATA_LIMIT || !mayBeLevelData(first)) return { state: 'other' }
        const bytes = await file.arrayBuffer()
        if (!isLevelDataContent(new Uint8Array(bytes))) return { state: 'other' }
        const time = file instanceof File ? file.lastModified : 0
        return { state: 'levelData', disk: await diskStateOfBytes(bytes, time) }
    } catch (error) {
        const failure = fileError(error)
        if (failure.code === 'not-found') return { state: 'missing' }
        return {
            state: 'unreadable',
            error: new FileError(failure.code, failure.message, undefined, 'read'),
        }
    }
}

/** Asks until the answer is not Choose Another…, whose picker exports or comes back here. */
const choose = async <T extends string>(
    ctx: ExportContext,
    ask: () => Promise<T | 'chooseAnother' | undefined>,
): Promise<T | ExportOutcome | undefined> => {
    for (;;) {
        const choice = await ask()
        if (choice !== 'chooseAnother') return choice
        const outcome = await exportByPicker(ctx)
        if (outcome !== 'back') return outcome
    }
}

const ended = (choice: string | undefined): ExportOutcome =>
    choice === 'done' ? 'done' : 'cancelled'

/** A target that is not as expected; never written over unless it is level data (§1.4.8). */
const conflicted = async (ctx: ExportContext, target: ExportTarget): Promise<ExportOutcome> => {
    const { name } = target
    const found = await readTarget({ kind: 'handle', handle: target.handle })
    switch (found.state) {
        case 'missing':
            return ended(await choose(ctx, () => ctx.ui.notFound(name)))
        case 'unreadable':
            return ended(await choose(ctx, () => ctx.ui.failed(name, found.error)))
        case 'other':
            return ended(await choose(ctx, () => ctx.ui.notLevelData(name)))
        case 'levelData': {
            const choice = await choose(ctx, () =>
                ctx.ui.conflict(name, found.disk, !target.exported),
            )
            if (choice === 'replace') return exportToTarget(ctx, target, found.disk)
            return ended(choice)
        }
    }
}

/**
 * Exports to the remembered target. saveFile is the first call, so `requestPermission` is the
 * first call on the gesture; the changed-on-disk check compares the file with `expected`.
 */
export const exportToTarget = async (
    ctx: ExportContext,
    target: ExportTarget,
    expected: DiskState = target.disk,
): Promise<ExportOutcome> => {
    const body = built(ctx)
    let error: FileError
    try {
        const result = await platform.saveFile({
            kind: 'nsld',
            suggestedName: target.name,
            target: { kind: 'handle', handle: target.handle },
            expected,
            replaced: 'discard',
            build: body.build,
            signal: ctx.signal,
        })
        if (result.status === 'saved') {
            saved(ctx, result)
            return 'done'
        }
        return 'cancelled'
    } catch (caught) {
        // A cancelled export ends here: no dialog follows the one that closed.
        if (cancelled(ctx)) return 'cancelled'
        error = fileError(caught)
    }

    ctx.leave()
    const { name } = target
    switch (error.code) {
        case 'conflict':
            return conflicted(ctx, target)
        case 'not-found':
            return ended(await choose(ctx, () => ctx.ui.notFound(name)))
        case 'denied': {
            const choice = await choose(ctx, () => ctx.ui.denied(name))
            if (choice === 'tryAgain') return exportToTarget(ctx, target, expected)
            return ended(choice)
        }
        case 'not-local':
        case 'no-space':
        case 'io':
            break
    }
    return ended(await choose(ctx, () => ctx.ui.failed(name, error)))
}

/** After a refused pick: the refusal, or the bytes to download when they could not go back. */
const afterRefusal = async (ctx: ExportContext, refused: RefusedPick) => {
    const { name } = refused
    if (refused.left === 'restored') {
        const ask =
            refused.reason === 'notLevelData'
                ? () => ctx.ui.notLevelData(name)
                : () => ctx.ui.unsupportedParts(name)
        return ended(await choose(ctx, ask))
    }
    if ((await ctx.ui.notPutBack(name, refused.left === 'empty')) !== 'download') return 'cancelled'
    try {
        const result = await downloadOpened(refused)
        if (result.status === 'download-started')
            ctx.ui.downloadStarted(result.name, refused.bytes.byteLength)
    } catch (caught) {
        const error = fileError(caught)
        return ended(await choose(ctx, () => ctx.ui.failed(error.fileName ?? name, error)))
    }
    return 'cancelled'
}

/** Exports through the save picker, or downloads where there is none. */
export const exportByPicker = async (ctx: ExportContext): Promise<ExportOutcome> => {
    const body = built(ctx)
    let refused: RefusedPick | undefined
    let accepted = false as boolean
    let result: SaveResult
    try {
        result = await platform.saveFile({
            kind: 'nsld',
            suggestedName: ctx.suggestedName,
            picker: { id: 'levelData', types: ctx.types },
            build: body.build,
            ready: ctx.ready,
            signal: ctx.signal,
            picked: async (target) => {
                refused = await refusePick(target)
                if (refused) return false
                // A cancel before this point is still honoured, with nothing written.
                accepted = !cancelled(ctx)
                if (accepted) ctx.committed?.()
                return true
            },
        })
    } catch (caught) {
        // An accepted pick was emptied (D5): its failure is shown even after a cancel.
        if (cancelled(ctx) && !accepted) return 'cancelled'
        const error = fileError(caught)
        ctx.leave()
        const name = error.fileName ?? ctx.suggestedName
        return ended(await choose(ctx, () => ctx.ui.failed(name, error)))
    }

    switch (result.status) {
        case 'saved':
            saved(ctx, result)
            return 'done'
        case 'download-started':
        case 'exported':
            if (ctx.exportName !== undefined) exportMemory.exportName = ctx.exportName
            ctx.ui.markExported?.(result.name)
            ctx.ui.downloadStarted(result.name, body.size())
            return 'done'
        case 'cancelled':
            break
    }
    if (!refused) return 'back'
    // A file left empty is reported even after a cancel.
    if (cancelled(ctx) && refused.left === 'restored') return 'cancelled'
    ctx.leave()
    return afterRefusal(ctx, refused)
}
