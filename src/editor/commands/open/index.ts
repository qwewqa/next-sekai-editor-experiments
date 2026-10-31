import type { Command } from '..'
import type { Chart } from '../../../chart'
import { recordError } from '../../../diagnostics'
import { detectHead, detectZip } from '../../../files/detect'
import { resetImportedState } from '../../../history'
import { captureName } from '../../../history/operations'
import { leavePeek } from '../../../history/peek'
import { createSessionDescriptor } from '../../../history/session'
import { i18n } from '../../../i18n'
import { LEVEL_FILE_MAX_BYTES } from '../../../levelData/fileLimit'
import { isGzip } from '../../../levelData/gzip'
import type { parseLevelData } from '../../../levelData/parse'
import type { LevelDataReport } from '../../../levelData/report'
import {
    getLevelDataRevision,
    getRevisionWarning,
    type RevisionWarning,
} from '../../../levelData/revision'
import { showModal } from '../../../modals'
import { showChoice } from '../../../modals/choice'
import InfoModal from '../../../modals/InfoModal.vue'
import { describeFailure } from '../../../modals/loadingFailure'
import LoadingModal from '../../../modals/LoadingModal.vue'
import { levelDataDiskState } from '../../../platform'
import { createState } from '../../../state'
import { errorMessage } from '../../../utils/error'
import { getFilename, pickFileForOpen } from '../../../utils/file'
import { inlineName } from '../../../utils/inlineName'
import { interpolate } from '../../../utils/interpolate'
import { timeout } from '../../../utils/promise'
import { loadForAction } from '../../loadFailure'
import { notify } from '../../notification'
import { forgetOpenedPackage } from '../../save/openedPackages'
import { confirmSwitch, notifyLeft } from '../../switch'
import { withSwitchRequest, type SwitchRequest } from '../../switchRequest'
import { changeBgm } from '../bgm/index.ts'
import { exportMemory, KEPT_BYTES_LIMIT, rememberExport } from '../exportLevel/memory'

import { installDropGuard } from './dropGuard'
import {
    FileTooLargeError,
    openErrorText,
    parseImported,
    RefusedFileError,
    tryImport,
    UnsupportedFileError,
} from './levelData'
import OpenIcon from './OpenIcon.vue'
import { dropOpen, endOpen, openFormat, startOpen } from './report'

installDropGuard()

export const open: Command = {
    title: () => i18n.value.commands.open.title,
    icon: {
        is: OpenIcon,
    },

    leavesPeek: true,

    execute() {
        return withSwitchRequest(undefined, async (request) => {
            // Confirmed before the pick, which needs the press's activation.
            if (!(await confirmSwitch()) || !request.isCurrent()) return

            // Unfiltered, keeping the handle where the picker exists.
            const { file, handle } = await pickFileForOpen('nse-open')
            if (!file || !request.isCurrent()) return
            await openPicked({ file, handle, confirmed: true, request })
        })
    },
}

/** A file to open, from any entry point. */
export type PickedForOpen = {
    file: File
    handle?: FileSystemFileHandle | undefined
    /**
     * The switch was confirmed already, with `request`. Otherwise the confirmation comes after
     * detection, just before something is replaced.
     */
    confirmed: boolean
    request?: SwitchRequest
}

/** Runs a switch: in the request already confirmed, or in one made and confirmed now. */
export type Switching = (run: (request: SwitchRequest) => Promise<void>) => Promise<void>

/**
 * Opens a picked file by its content. Every entry point calls this, so none can leave work
 * without the confirmation: audio, an archive's message or a package's list replace nothing.
 */
export const openPicked = async (picked: PickedForOpen) => {
    const { file, handle } = picked
    const supplied = picked.confirmed ? picked.request : undefined
    // A request already given must still be current; one made here has nothing to go stale.
    const isCurrent = () => !supplied || supplied.isCurrent()
    const switching: Switching = async (run) => {
        if (supplied) {
            if (supplied.isCurrent()) await run(supplied)
            return
        }
        await withSwitchRequest(undefined, async (request) => {
            if (!(await confirmSwitch()) || !request.isCurrent()) return
            await run(request)
        })
    }
    startOpen(file)
    try {
        // A failed read here surfaces in the loading modal below.
        const detected = await detectHead(file).catch(() => 'data' as const)
        // A ZIP that cannot be classified goes on to the project reader, which says why.
        const kind =
            detected === 'zip' ? await detectZip(file).catch(() => 'project' as const) : undefined
        if (!isCurrent()) return
        // Read as anything else, the file is no longer a package this tab opened.
        if (handle && kind !== 'package') await forgetOpenedPackage(handle)
        if (detected === 'audio') {
            // Audio replaces the chart's BGM: an edit, so the peek ends first.
            dropOpen()
            leavePeek()
            void changeBgm(file)
            return
        }
        if (detected === 'data') {
            await switching((request) => openData(file, handle, request))
            return
        }
        // An archive or a Sonolus package is named, not opened: nothing is replaced.
        if (kind === 'archive') {
            dropOpen()
            await showModal(InfoModal, {
                title: () => i18n.value.commands.open.dialogTitle,
                message: () => i18n.value.open.severalProjects,
            })
            return
        }
        if (kind === 'package') {
            const flow = await loadForAction(() => import('./packageFlow'))
            if (!flow) {
                dropOpen()
                return
            }
            await flow.openPackage(file, handle, supplied)
            return
        }
        await switching((request) => openProjectFile(file, handle, request))
    } finally {
        // Whatever has not ended the open by now was left: a cancelled dialog or choice.
        endOpen('cancelled')
    }
}

/** A project file, read in the storage worker. */
const openProjectFile = async (
    file: File,
    handle: FileSystemFileHandle | undefined,
    request: SwitchRequest,
) => {
    const project = await loadForAction(() => import('./project'))
    if (!project) {
        dropOpen()
        return
    }
    openFormat('nxsp')
    try {
        if (!request.isCurrent()) return
        await project.openProject(file, handle, request)
    } catch (error) {
        recordError(error)
        console.error(error)
        endOpen('failed')
        if (request.isCurrent())
            notify(() => describeFailure(error).headline?.() ?? errorMessage(error), {
                card: true,
                severity: 'error',
            })
    }
}

/** Level data, a Chart Cyanvas level, or a USC or SUS chart, read whole. */
const openData = async (
    file: File,
    handle: FileSystemFileHandle | undefined,
    request: SwitchRequest,
) => {
    let sourceBuffer: ArrayBuffer | undefined
    let warning: OpenWarning | undefined
    // Values this build does not know: the level opens only after its confirm.
    let newerValues: (() => Promise<OpenWarning | undefined>) | undefined
    await showModal(LoadingModal, {
        title: () => i18n.value.commands.open.dialogTitle,
        async *task(signal: AbortSignal) {
            const stopAbort = request.observeAbort(signal)
            try {
                yield () => i18n.value.commands.open.loading

                // Refused by size before it is read; a gzip is checked as it inflates.
                if (file.size > LEVEL_FILE_MAX_BYTES)
                    throw new FileTooLargeError('The file is over the limit')
                const buffer = await file.arrayBuffer()
                sourceBuffer = buffer
                signal.throwIfAborted()
                if (!request.isCurrent()) return

                yield () => i18n.value.commands.open.importing
                await timeout(50)
                signal.throwIfAborted()
                if (!request.isCurrent()) return

                const [type, data] = tryImport(buffer)
                openFormat(type)
                const parsed = parseImported(type, data)
                let partial = false
                if (parsed.type === 'levelData') {
                    const { levelData, chart, report } = parsed
                    const apply = () =>
                        applyLevelData(file, handle, buffer, levelData, chart, report, request)
                    if (report.hasUnknownValue) {
                        newerValues = apply
                        return
                    }
                    partial = !report.isEmpty
                    warning = await apply()
                } else if (!resetImported(request, parsed.chart, parsed.offset, file)) return

                await opened(handle, buffer, type, partial, request)
            } catch (error) {
                if (request.isCurrent()) {
                    if (error instanceof UnsupportedFileError || error instanceof FileTooLargeError)
                        endOpen('refused', 'unsupported')
                    else if (error instanceof RefusedFileError) endOpen('refused', 'invalid')
                    else endOpen('failed')
                    throw localizedOpenError(error)
                }
            } finally {
                stopAbort()
            }
        },
    })
    if (!request.isCurrent()) return
    if (newerValues) {
        const apply = newerValues
        const choice = await confirmNewerValues(file.name)
        // Cancel opens nothing and leaves the session as it was.
        if (!choice || !sourceBuffer || !request.isCurrent()) return
        warning = await apply()
        await opened(handle, sourceBuffer, 'levelData', true, request)
    }
    if (!warning || !request.isCurrent()) return
    showOpenWarning(warning)
}

/** An open's error as the loading dialog shows it, in the current language. */
export const localizedOpenError = (error: unknown) => {
    const { open } = i18n.value.commands
    const text = openErrorText(error, {
        unsupported: open.unsupported,
        tooLarge: open.tooLarge,
        invalidLevel: open.invalidLevel,
        invalidChart: open.invalidChart,
        refusals: open.refusals,
        levelUnreadable: i18n.value.open.package.levelUnreadable,
        fileUnreadable: i18n.value.commands.previewAssets.import.fileUnreadable,
    })
    return text === undefined ? error : new Error(text, { cause: error })
}

/** What an opened level left out, or the engine revision it was made for. */
export type OpenWarning = RevisionWarning | 'unsupportedParts'

/** The "Open a Copy" choice for a level with values this build does not know. */
export const confirmNewerValues = (name: string) =>
    showChoice({
        title: interpolate(() => i18n.value.open.newerValues.title, inlineName(name)),
        message: () => i18n.value.open.newerValues.body,
        choices: [
            {
                value: true,
                label: () => i18n.value.open.newerValues.openCopy,
                default: true,
            },
        ],
    })

export const showOpenWarning = (warning: OpenWarning) => {
    void showModal(InfoModal, {
        title: () => i18n.value.commands.open.dialogTitle,
        message: () =>
            warning === 'unsupportedParts'
                ? i18n.value.commands.open.unsupportedParts
                : i18n.value.commands.open.revision[warning],
    })
}

/**
 * Opens parsed level data: a new session, with its handle and Export's target when it was read
 * whole. Content this build did not read makes it partial: no file is written over.
 */
const applyLevelData = async (
    file: File,
    handle: FileSystemFileHandle | undefined,
    buffer: ArrayBuffer,
    levelData: ReturnType<typeof parseLevelData>,
    chart: Chart,
    report: LevelDataReport,
    request: SwitchRequest,
): Promise<RevisionWarning | 'unsupportedParts' | undefined> => {
    const revisionWarning = getRevisionWarning(getLevelDataRevision(levelData.entities), chart)
    const complete = report.isEmpty
    const disk =
        complete && isGzip(buffer) && handle
            ? await levelDataDiskState(
                  new File([buffer], file.name, { lastModified: file.lastModified }),
              )
            : undefined
    if (resetImported(request, chart, levelData.bgmOffset, file)) {
        if (!complete) exportMemory.partial = true
        if (complete && isGzip(buffer)) {
            exportMemory.sourceName = file.name
            if (handle && disk)
                exportMemory.target = { name: handle.name, handle, disk, exported: false }
        }
    }
    return complete ? revisionWarning : 'unsupportedParts'
}

/** After an open: the source's bytes kept, the chain's Export fields stored, the notice. */
const opened = async (
    handle: FileSystemFileHandle | undefined,
    buffer: ArrayBuffer,
    type: keyof typeof openedMessages,
    partial: boolean,
    request: SwitchRequest,
) => {
    if (!request.isCurrent()) return
    // The source's bytes, so a save picker that empties it can be undone.
    if (handle)
        exportMemory.opened = {
            handle,
            levelData: type === 'levelData',
            partial,
            // Complete level data may be written over; anything else is kept.
            bytes: type === 'levelData' && !partial ? undefined : buffer,
            // The project picker never writes over any of them.
            ...(buffer.byteLength <= KEPT_BYTES_LIMIT ? { kept: buffer } : {}),
        }

    // The target and the partial flag are the new chain's.
    await rememberExport()
    endOpen('done')
    // With Reopen while the session left can be reopened.
    if (request.isCurrent()) notifyLeft(() => i18n.value.commands.open[openedMessages[type]])
}

const openedMessages = {
    levelData: 'opened',
    chcy: 'importedChcy',
    usc: 'importedUsc',
    sus: 'importedSus',
} as const

const resetImported = (request: SwitchRequest, chart: Chart, offset: number, file: File) => {
    const descriptor = createSessionDescriptor({ sourceName: getFilename(file) })
    const state = createState(chart, offset)
    return request.publish({ state, sessionId: descriptor.sessionId, reset: true }, () => {
        resetImportedState(state, descriptor, captureName(getFilename(file)))
    })
}
