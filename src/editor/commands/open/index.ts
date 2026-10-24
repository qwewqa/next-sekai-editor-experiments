import { ungzip } from 'pako'
import { AssertError } from 'typebox/value'
import type { Command } from '..'
import type { Chart } from '../../../chart'
import { parseLevelDataChart } from '../../../chart/parse/levelData'
import { parseSusChart } from '../../../chart/parse/sus'
import { parseUscChart } from '../../../chart/parse/usc'
import { ImportRefusal } from '../../../chart/refusal'
import { validateChart } from '../../../chart/validate'
import { chcyToUsc, isChcyLevelData } from '../../../chcy/convert'
import { recordError } from '../../../diagnostics'
import { detectHead, detectZip } from '../../../files/detect'
import { resetImportedState } from '../../../history'
import { captureName } from '../../../history/operations'
import { leavePeek } from '../../../history/peek'
import { createSessionDescriptor } from '../../../history/session'
import { i18n } from '../../../i18n'
import { parseLevelData } from '../../../levelData/parse'
import { LevelDataReport } from '../../../levelData/report'
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
import { parseSus } from '../../../sus/parse'
import { parseUsc } from '../../../usc/parse'
import { errorMessage } from '../../../utils/error'
import { getFilename, pickFileForOpen } from '../../../utils/file'
import { interpolate, interpolateRaw } from '../../../utils/interpolate'
import { timeout } from '../../../utils/promise'
import { notify } from '../../notification'
import { confirmSwitch, notifyLeft } from '../../switch'
import { withSwitchRequest, type SwitchRequest } from '../../switchRequest'
import { changeBgm } from '../bgm/index.ts'
import { exportMemory, KEPT_BYTES_LIMIT, rememberExport } from '../exportLevel/memory'
import { showPreviewAssets } from '../previewAssets/modal'
import { installDropGuard } from './dropGuard'
import OpenIcon from './OpenIcon.vue'

installDropGuard()

export const open: Command = {
    title: () => i18n.value.commands.open.title,
    icon: {
        is: OpenIcon,
    },

    leavesPeek: true,

    async execute() {
        return withSwitchRequest(undefined, async (request) => {
            if (!(await confirmSwitch()) || !request.isCurrent()) return

            // Unfiltered, keeping the handle where the picker exists.
            const { file, handle } = await pickFileForOpen('nse-open')
            if (!file || !request.isCurrent()) return

            // A failed read here surfaces in the loading modal below.
            const detected = await detectHead(file).catch(() => 'data' as const)
            if (!request.isCurrent()) return
            if (detected === 'audio') {
                // Audio replaces the chart's BGM: an edit, so the peek ends first.
                leavePeek()
                void changeBgm(file)
                return
            }
            if (detected === 'zip') {
                // An archive or a Sonolus package is named, not opened: nothing is
                // replaced. A ZIP that cannot be classified goes on to the project reader, which
                // says why it cannot open.
                const kind = await detectZip(file).catch(() => 'project' as const)
                if (!request.isCurrent()) return
                if (kind === 'archive') {
                    await showModal(InfoModal, {
                        title: () => i18n.value.commands.open.title,
                        message: () => i18n.value.open.severalProjects,
                    })
                    return
                }
                if (kind === 'package') {
                    const choice = await showChoice({
                        title: () => i18n.value.commands.open.title,
                        message: () => i18n.value.open.scp,
                        choices: [
                            {
                                value: true,
                                label: () => i18n.value.open.openPreviewAssets,
                                default: true,
                            },
                        ],
                        cancelLabel: () => i18n.value.modals.info.ok,
                    })
                    if (choice) await showPreviewAssets(undefined, { file })
                    return
                }
                // A project file, read in the storage worker.
                const { openProject } = await import('./project')
                try {
                    if (!request.isCurrent()) return
                    await openProject(file, handle, request)
                } catch (error) {
                    recordError(error)
                    console.error(error)
                    if (request.isCurrent())
                        notify(() => describeFailure(error).headline?.() ?? errorMessage(error), {
                            card: true,
                            severity: 'error',
                        })
                }
                return
            }

            let sourceBuffer: ArrayBuffer | undefined
            let warning: RevisionWarning | 'unsupportedParts' | undefined
            // Values this build doesn't know: the level opens only after its confirm.
            let newerValues:
                (() => Promise<RevisionWarning | 'unsupportedParts' | undefined>) | undefined
            await showModal(LoadingModal, {
                title: () => i18n.value.commands.open.title,
                async *task(signal: AbortSignal) {
                    const stopAbort = request.observeAbort(signal)
                    try {
                        yield () => i18n.value.commands.open.loading

                        const buffer = await file.arrayBuffer()
                        sourceBuffer = buffer
                        signal.throwIfAborted()
                        if (!request.isCurrent()) return

                        yield () => i18n.value.commands.open.importing
                        await timeout(50)
                        signal.throwIfAborted()
                        if (!request.isCurrent()) return

                        const [type, data] = tryImport(buffer)
                        let partial = false
                        try {
                            switch (type) {
                                case 'chcy': {
                                    const { offset, objects } = chcyToUsc(parseLevelData(data))

                                    const chart = parseUscChart(objects)
                                    validateChart(chart)

                                    if (!resetImported(request, chart, offset, file)) return
                                    break
                                }
                                case 'levelData': {
                                    const levelData = parseLevelData(data)
                                    const report = new LevelDataReport()
                                    const chart = parseLevelDataChart(
                                        levelData.entities,
                                        undefined,
                                        undefined,
                                        report,
                                    )
                                    validateChart(chart)
                                    const apply = () =>
                                        applyLevelData(
                                            file,
                                            handle,
                                            buffer,
                                            levelData,
                                            chart,
                                            report,
                                            request,
                                        )
                                    if (report.hasUnknownValue) {
                                        newerValues = apply
                                        return
                                    }
                                    partial = !report.isEmpty
                                    warning = await apply()
                                    break
                                }
                                case 'usc': {
                                    const { usc } = parseUsc(data)

                                    const chart = parseUscChart(usc.objects)
                                    validateChart(chart)

                                    if (!resetImported(request, chart, usc.offset, file)) return
                                    break
                                }
                                case 'sus': {
                                    const sus = parseSus(data)

                                    const chart = parseSusChart(sus)
                                    validateChart(chart)

                                    if (!resetImported(request, chart, sus.offset, file)) return
                                    break
                                }
                            }
                        } catch (error) {
                            // A file its format's schema refuses is one the editor cannot read.
                            if (error instanceof AssertError) throw new UnsupportedFileError()
                            if (error instanceof ImportRefusal)
                                throw new RefusedFileError(type, error)
                            throw error
                        }

                        await opened(handle, buffer, type, partial, request)
                    } catch (error) {
                        if (request.isCurrent()) throw error
                    } finally {
                        stopAbort()
                    }
                },
            })
            if (!request.isCurrent()) return
            if (newerValues) {
                const apply = newerValues
                const choice = await showChoice({
                    title: interpolate(() => i18n.value.open.newerValues.title, file.name),
                    message: () => i18n.value.open.newerValues.body,
                    choices: [
                        {
                            value: true,
                            label: () => i18n.value.open.newerValues.openCopy,
                            default: true,
                        },
                    ],
                })
                // Cancel opens nothing and leaves the session as it was.
                if (!choice || !sourceBuffer || !request.isCurrent()) return
                warning = await apply()
                await opened(handle, sourceBuffer, 'levelData', true, request)
            }
            if (!warning || !request.isCurrent()) return

            const message = warning
            void showModal(InfoModal, {
                title: () => i18n.value.commands.open.title,
                message: () =>
                    message === 'unsupportedParts'
                        ? i18n.value.commands.open.unsupportedParts
                        : i18n.value.commands.open.revision[message],
            })
        })
    },
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
    // With Reopen while the session left can be reopened.
    if (request.isCurrent()) notifyLeft(() => i18n.value.commands.open[openedMessages[type]])
}

const openedMessages = {
    levelData: 'opened',
    chcy: 'importedChcy',
    usc: 'importedUsc',
    sus: 'importedSus',
} as const

/**
 * Detects the format from the content: level data (gzipped, as Sonolus serves
 * it, or plain JSON), which is Chart Cyanvas level data when it has the
 * format's `TimeScaleGroup` entities; a USC chart; or a SUS chart.
 */
const tryImport = (buffer: ArrayBuffer) => {
    const json = tryParseJson(buffer)
    if (isLevelDataLike(json)) {
        return isChcyLevelData(json) ? (['chcy', json] as const) : (['levelData', json] as const)
    }
    if (json !== undefined) return ['usc', json] as const

    const sus = tryImportSus(buffer)
    if (sus) return ['sus', sus] as const

    throw new UnsupportedFileError()
}

class UnsupportedFileError extends Error {
    constructor() {
        super(i18n.value.commands.open.unsupported)
    }
}

// SUS, USC and Chart Cyanvas files are charts rather than levels.
class RefusedFileError extends Error {
    constructor(type: 'levelData' | 'chcy' | 'usc' | 'sus', refusal: ImportRefusal) {
        const { open } = i18n.value.commands
        super(
            interpolateRaw(
                type === 'levelData' ? open.invalidLevel : open.invalidChart,
                interpolateRaw(open.refusals[refusal.reason], ...refusal.params),
            ),
            { cause: refusal },
        )
    }
}

const isLevelDataLike = (data: unknown) =>
    typeof data === 'object' && data !== null && 'entities' in data

const isGzip = (buffer: ArrayBuffer) => {
    const bytes = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength))
    return bytes[0] === 0x1f && bytes[1] === 0x8b
}

const tryParseJson = (buffer: ArrayBuffer): unknown => {
    const bytes = new Uint8Array(buffer)
    try {
        return JSON.parse(new TextDecoder().decode(isGzip(buffer) ? ungzip(bytes) : bytes))
    } catch {
        return
    }
}

const tryImportSus = (buffer: ArrayBuffer) => {
    try {
        const data = new TextDecoder().decode(buffer).split('\n')
        if (data.filter((line) => line.startsWith('#')).length < 10) return

        return data
    } catch {
        return
    }
}

const resetImported = (request: SwitchRequest, chart: Chart, offset: number, file: File) => {
    const descriptor = createSessionDescriptor({ sourceName: getFilename(file) })
    const state = createState(chart, offset)
    return request.publish({ state, sessionId: descriptor.sessionId, reset: true }, () => {
        resetImportedState(state, descriptor, captureName(getFilename(file)))
    })
}
