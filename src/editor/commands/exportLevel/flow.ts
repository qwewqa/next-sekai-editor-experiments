import { isZipHead } from '../../../files/detect'
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
import { ZipReader } from '../../../zip'
import type { PickedLevelData } from '../../save/exportPick'
import type { ReadResult } from '../../save/pickSession'
import { isLevelDataContent, mayBeLevelData } from './content'
import { fileError } from './errorText'
import {
    exportMemory,
    ownsExportTarget,
    rememberExport,
    replaceExportTarget,
    type ExportTarget,
} from './memory'
import { withTargetLock } from './targetLock'

// Export Level Data…'s writes, apart from its dialogs, so Node tests can run them.

/** What a follow-up dialog answers; undefined is Cancel. */
export type ExportUi = {
    /** The conflict dialog's Export form; `opened` while the target is the opened file. */
    conflict: (
        name: string,
        /** The file as read; `lastModified` is undefined when the blob does not say. */
        disk: Omit<DiskState, 'lastModified'> & { lastModified: number | undefined },
        opened: boolean,
    ) => Promise<'replace' | 'chooseAnother' | undefined>
    notLevelData: (name: string) => Promise<'chooseAnother' | undefined>
    /** A pick of level data whose import left parts out. */
    unsupportedParts: (name: string) => Promise<'chooseAnother' | undefined>
    /**
     * What a pick of a file the editor holds bytes of could not put back, shown at once; `emptied`
     * while it is empty. Without `downloadable` there is nothing to give: [OK] only.
     */
    notPutBack: (
        name: string,
        emptied: boolean,
        downloadable: boolean,
    ) => Promise<'download' | undefined>
    notFound: (name: string) => Promise<'chooseAnother' | undefined>
    denied: (name: string) => Promise<'tryAgain' | 'chooseAnother' | undefined>
    failed: (name: string, error: FileError) => Promise<'chooseAnother' | undefined>
    exported: (name: string) => void
    downloadStarted: (name: string, size: number) => void
    /** Records the export in the session's timeline. */
    markExported?: (name: string, delivery: 'file' | 'download') => void
}

export type ExportContext = {
    ui: ExportUi
    /** Builds the file; called before any picker, since a picker empties what it returns. */
    build: () => Blob | Promise<Blob>
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
    /**
     * The dialog's read of the chain's own file, or `'start'` (the default): one starting
     * when the picker is asked for, with a grant already held.
     */
    read?: Promise<ReadResult> | 'start'
    /** Called when the picker returned a file: its write runs to its end, cancel or not. */
    committed?: () => void
}

/** done: written or handed over; cancelled: nothing written; back: the picker was dismissed. */
export type ExportOutcome = 'done' | 'cancelled' | 'back'

/** Above this, a file is not taken for level data without being read whole. */
const LEVEL_DATA_LIMIT = 64 * 1024 * 1024

// Only the user's cancel: a browser's own AbortError is a failure.
const cancelled = (ctx: ExportContext) => !!ctx.signal?.aborted

const built = (ctx: ExportContext) => {
    let size = 0
    return {
        build: async () => {
            const blob = await ctx.build()
            size = blob.size
            return blob
        },
        size: () => size,
    }
}

const remember = async (ctx: ExportContext, target: ExportTarget) => {
    await replaceExportTarget(target)
    if (ctx.exportName !== undefined) exportMemory.exportName = ctx.exportName
    await rememberExport()
}

/** Remembers a written file as the target; inside the hold that wrote it. */
export const rememberWritten = async (ctx: ExportContext, result: SaveResult) => {
    if (result.status !== 'saved') return
    if (result.target.kind !== 'handle' || !result.disk) throw new Error('Not a handle write')
    await remember(ctx, {
        name: result.name,
        handle: result.target.handle,
        disk: result.disk,
        exported: true,
    })
}

type Found =
    | { state: 'missing' }
    | { state: 'unreadable'; error: FileError }
    | { state: 'other' }
    /** `modified` is absent when the read blob does not say when the file was changed. */
    | { state: 'levelData'; disk: DiskState; modified?: number }

/**
 * The target as one read finds it, so its disk state and its content check describe the same
 * bytes.
 */
const readTarget = async (target: FileTarget): Promise<Found> => {
    try {
        const file = await platform.read(target)
        const [first] = new Uint8Array(await file.slice(0, 1).arrayBuffer())
        if (file.size > LEVEL_DATA_LIMIT || !mayBeLevelData(first)) return { state: 'other' }
        const bytes = await file.arrayBuffer()
        if (!isLevelDataContent(new Uint8Array(bytes))) return { state: 'other' }
        const modified = file instanceof File ? file.lastModified : undefined
        return {
            state: 'levelData',
            // The state's own time only compares: the dialog shows `modified`, never this 0.
            disk: await diskStateOfBytes(bytes, modified ?? 0),
            ...(modified === undefined ? {} : { modified }),
        }
    } catch (error) {
        const failure = fileError(error)
        if (failure.code === 'not-found') return { state: 'missing' }
        return {
            state: 'unreadable',
            error: new FileError(failure.code, failure.message, undefined, 'read'),
        }
    }
}

/**
 * Whether the file now holds a project: a ZIP whose `project.json` reads. Export never writes
 * level data over one, whatever it last found there. Anything else is not told apart here.
 */
const holdsProject = async (handle: FileSystemFileHandle) => {
    try {
        const file = await handle.getFile()
        if (!isZipHead(new Uint8Array(await file.slice(0, 64).arrayBuffer()))) return false
        const reader = await ZipReader.open(file)
        const entry = reader.get('project.json')
        if (!entry || entry.isDirectory) return false
        await reader.read(entry, { maxSize: 1024 * 1024 })
        return true
    } catch {
        // Only a project seen refuses; a file that cannot be read is the write's own check to report.
        return false
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
        // Its picker reads the chain's own file anew: the dialog's read was of an earlier time.
        const outcome = await exportByPicker({ ...ctx, read: 'start' })
        if (outcome !== 'back') return outcome
    }
}

const ended = (choice: string | undefined): ExportOutcome =>
    choice === 'done' ? 'done' : 'cancelled'

/** A target that is not as expected; never written over unless it is level data. */
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
                ctx.ui.conflict(
                    name,
                    {
                        ...found.disk,
                        lastModified: found.modified,
                    },
                    !target.exported,
                ),
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
    const revoked = new Error('Export destination was revoked')
    let error: FileError
    try {
        const result = await platform.saveFile({
            kind: 'nsld',
            suggestedName: target.name,
            target: { kind: 'handle', handle: target.handle },
            expected,
            replaced: 'discard',
            lock: (run) =>
                withTargetLock(async () => {
                    if (!(await ownsExportTarget(target))) {
                        throw revoked
                    }
                    // Never over a project, even one the remembered state matches (the Export guard).
                    if (await holdsProject(target.handle))
                        throw new FileError('conflict', `${target.name} holds a project`)
                    const result = await run()
                    await rememberWritten(ctx, result as SaveResult)
                    return result
                }),
            build: body.build,
            signal: ctx.signal,
        })
        if (result.status === 'saved') {
            ctx.ui.markExported?.(result.name, 'file')
            ctx.ui.exported(result.name)
            return 'done'
        }
        return 'cancelled'
    } catch (caught) {
        // A cancelled export ends here: no dialog follows the one that closed.
        if (cancelled(ctx)) return 'cancelled'
        if (caught === revoked) return exportByPicker(ctx)
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
        case 'read-only':
        case 'io':
            break
    }
    return ended(await choose(ctx, () => ctx.ui.failed(name, error)))
}

/** A failure no dialog has shown yet: the failed dialog, which offers Choose Another…. */
const failed = (ctx: ExportContext, error: FileError, fallback: string) => {
    ctx.leave()
    const name = error.fileName ?? fallback
    return choose(ctx, () => ctx.ui.failed(name, error)).then(ended)
}

/** Exports through the save picker, or downloads where there is none. */
export const exportByPicker = async (ctx: ExportContext): Promise<ExportOutcome> => {
    // Only the pick session opens a picker: build, verify, pick and write run there.
    if (platform.pickSaveFile) {
        // A failure after a Cancel, before a file was picked, is the Cancel's: no dialog follows.
        const pick = { committed: false }
        const counted: ExportContext = {
            ...ctx,
            committed: () => {
                pick.committed = true
                ctx.committed?.()
            },
        }
        let picked: PickedLevelData
        try {
            picked = await (await import('../../save/exportPick')).pickLevelData(counted)
        } catch (caught) {
            if (cancelled(ctx) && !pick.committed) return 'cancelled'
            return failed(ctx, fileError(caught), ctx.suggestedName)
        }
        if (picked.kind === 'failed' && cancelled(ctx) && !pick.committed) return 'cancelled'
        return afterPick(ctx, picked)
    }
    return exportByDownload(ctx)
}

/** What follows a pick: the feedback, or the dialog that says why nothing was exported. */
const afterPick = async (ctx: ExportContext, picked: PickedLevelData): Promise<ExportOutcome> => {
    switch (picked.kind) {
        case 'written': {
            const { result } = picked
            ctx.ui.markExported?.(result.name, 'file')
            ctx.ui.exported(result.name)
            return 'done'
        }
        case 'dismissed':
            return 'back'
        case 'cancelled':
            return 'cancelled'
        case 'failed':
            return failed(ctx, picked.error, ctx.suggestedName)
        case 'show':
            // The Save core's own dialog, once Export's has closed.
            ctx.leave()
            await picked.show()
            return 'cancelled'
        case 'refused':
        case 'ownProject': {
            // The file is not level data: it was put back, or the chain's project went into it.
            ctx.leave()
            const { name } = picked
            const ask =
                picked.kind === 'refused' && picked.reason === 'unsupportedParts'
                    ? () => ctx.ui.unsupportedParts(name)
                    : () => ctx.ui.notLevelData(name)
            return ended(await choose(ctx, ask))
        }
    }
}

/** A browser without a save picker: the level data is downloaded. */
const exportByDownload = async (ctx: ExportContext): Promise<ExportOutcome> => {
    const body = built(ctx)
    let result: SaveResult
    try {
        result = await platform.saveFile({
            kind: 'nsld',
            suggestedName: ctx.suggestedName,
            build: body.build,
            ready: ctx.ready,
            signal: ctx.signal,
        })
    } catch (caught) {
        if (cancelled(ctx)) return 'cancelled'
        return failed(ctx, fileError(caught), ctx.suggestedName)
    }
    switch (result.status) {
        // Without a target, a save only downloads.
        case 'saved':
        case 'download-started':
        case 'exported':
            if (ctx.exportName !== undefined) {
                exportMemory.exportName = ctx.exportName
                await rememberExport()
            }
            ctx.ui.markExported?.(result.name, 'download')
            ctx.ui.downloadStarted(result.name, body.size())
            return 'done'
        case 'cancelled':
            return 'back'
    }
}
