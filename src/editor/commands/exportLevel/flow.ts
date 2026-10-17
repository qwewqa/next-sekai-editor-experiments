import {
    FileError,
    platform,
    type DiskState,
    type FileTarget,
    type ReadyPrompt,
    type SavePickerType,
    type SaveResult,
} from '../../../platform'
import { isLevelDataContent } from './content'
import { exportMemory, sameEntry, type ExportTarget } from './memory'

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
    notFound: (name: string) => Promise<'chooseAnother' | undefined>
    denied: (name: string) => Promise<'tryAgain' | 'chooseAnother' | undefined>
    failed: (name: string, reason: string) => Promise<'chooseAnother' | undefined>
    exported: (name: string) => void
    downloadStarted: (name: string, size: number) => void
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
}

/** done: written or handed over; cancelled: nothing written; back: the picker was dismissed. */
export type ExportOutcome = 'done' | 'cancelled' | 'back'

const fileError = (error: unknown) => {
    if (error instanceof FileError) return error
    return new FileError('io', error instanceof Error ? error.message : String(error))
}

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
    ctx.ui.exported(result.name)
}

/** Whether the file a target names holds level data now; unreadable counts as not. */
const holdsLevelData = async (target: FileTarget) => {
    try {
        return isLevelDataContent(new Uint8Array(await (await platform.read(target)).arrayBuffer()))
    } catch {
        return false
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
        })
        if (result.status === 'saved') {
            saved(ctx, result)
            return 'done'
        }
        return 'cancelled'
    } catch (caught) {
        error = fileError(caught)
    }

    ctx.leave()
    const { name } = target
    const handleTarget: FileTarget = { kind: 'handle', handle: target.handle }
    const choose = async (ask: () => Promise<string | undefined>) => {
        for (;;) {
            const choice = await ask()
            if (choice !== 'chooseAnother') return choice
            const outcome = await exportByPicker(ctx)
            if (outcome !== 'back') return outcome
        }
    }
    switch (error.code) {
        case 'conflict': {
            // A change found while reading has no disk state yet.
            const found =
                error.disk ?? (await platform.inspect(handleTarget).catch(() => undefined))
            if (found === 'missing') {
                const choice = await choose(() => ctx.ui.notFound(name))
                return choice === 'done' ? 'done' : 'cancelled'
            }
            // Never over a file that is not level data (§1.4.8): the file on disk is read first.
            if (!found || !(await holdsLevelData(handleTarget))) {
                const choice = await choose(() => ctx.ui.notLevelData(name))
                return choice === 'done' ? 'done' : 'cancelled'
            }
            const choice = await choose(() => ctx.ui.conflict(name, found, !target.exported))
            if (choice === 'replace') return exportToTarget(ctx, target, found)
            return choice === 'done' ? 'done' : 'cancelled'
        }
        case 'not-found': {
            const choice = await choose(() => ctx.ui.notFound(name))
            return choice === 'done' ? 'done' : 'cancelled'
        }
        case 'denied': {
            const choice = await choose(() => ctx.ui.denied(name))
            if (choice === 'tryAgain') return exportToTarget(ctx, target, expected)
            return choice === 'done' ? 'done' : 'cancelled'
        }
        case 'not-local':
        case 'no-space':
        case 'io': {
            const choice = await choose(() => ctx.ui.failed(name, error.message))
            return choice === 'done' ? 'done' : 'cancelled'
        }
    }
}

/**
 * A picked file this tab read at open and found not to be level data; the picker emptied it
 * (D5), so its bytes are put back, on the condition that it is still the empty file.
 */
const refusedPick = async (target: FileTarget) => {
    const { opened } = exportMemory
    if (target.kind !== 'handle' || !opened || opened.levelData) return false
    if (!(await sameEntry(target.handle, opened.handle))) return false
    const { bytes } = opened
    if (!bytes) return true
    try {
        const disk = await platform.inspect(target)
        if (disk !== 'missing' && disk.size === 0)
            await platform.saveFile({
                kind: 'recovery',
                suggestedName: target.handle.name,
                target,
                expected: disk,
                build: () => Promise.resolve(new Blob([bytes])),
            })
    } catch {
        // Putting it back is best effort; the refusal still stands.
    }
    return true
}

/** Exports through the save picker, or downloads where there is none. */
export const exportByPicker = async (ctx: ExportContext): Promise<ExportOutcome> => {
    const body = built(ctx)
    let refused: string | undefined
    let result: SaveResult
    try {
        result = await platform.saveFile({
            kind: 'nsld',
            suggestedName: ctx.suggestedName,
            picker: { id: 'levelData', types: ctx.types },
            build: body.build,
            ready: ctx.ready,
            picked: async (target) => {
                if (!(await refusedPick(target))) return true
                refused = target.kind === 'handle' ? target.handle.name : ctx.suggestedName
                return false
            },
        })
    } catch (caught) {
        const error = fileError(caught)
        ctx.leave()
        for (;;) {
            if ((await ctx.ui.failed(ctx.suggestedName, error.message)) !== 'chooseAnother')
                return 'cancelled'
            const outcome = await exportByPicker(ctx)
            if (outcome !== 'back') return outcome
        }
    }

    switch (result.status) {
        case 'saved':
            saved(ctx, result)
            return 'done'
        case 'download-started':
        case 'exported':
            if (ctx.exportName !== undefined) exportMemory.exportName = ctx.exportName
            ctx.ui.downloadStarted(result.name, body.size())
            return 'done'
        case 'cancelled':
            break
    }
    if (refused === undefined) return 'back'
    ctx.leave()
    const name = refused
    for (;;) {
        if ((await ctx.ui.notLevelData(name)) !== 'chooseAnother') return 'cancelled'
        const outcome = await exportByPicker(ctx)
        if (outcome !== 'back') return outcome
    }
}
