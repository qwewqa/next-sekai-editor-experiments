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
import { detectHead } from '../../../files/detect'
import { resetState, setLevelDataHandle } from '../../../history'
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
import LoadingModal from '../../../modals/LoadingModal.vue'
import { levelDataDiskState } from '../../../platform'
import { parseSus } from '../../../sus/parse'
import { parseUsc } from '../../../usc/parse'
import { errorMessage } from '../../../utils/error'
import { getFilename, pickFileForOpen } from '../../../utils/file'
import { interpolate, interpolateRaw } from '../../../utils/interpolate'
import { timeout } from '../../../utils/promise'
import { notify } from '../../notification'
import { confirmSwitch, notifyLeft } from '../../switch'
import { changeBgm } from '../bgm/index.ts'
import { exportMemory, rememberExport } from '../exportLevel/memory'
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
        if (!(await confirmSwitch())) return

        const { file, handle } = await pickFileForOpen('levelData')
        if (!file) return

        // A failed read here surfaces in the loading modal below.
        const detected = await detectHead(file).catch(() => 'data' as const)
        if (detected === 'audio') {
            void changeBgm(file)
            return
        }
        // A ZIP is a project file, read in the storage worker (§1.5.4).
        if (detected === 'zip') {
            const { openProject } = await import('./project')
            try {
                await openProject(file, handle)
            } catch (error) {
                console.error(error)
                notify(() => errorMessage(error), { card: true })
            }
            return
        }

        let warning: RevisionWarning | 'unsupportedParts' | undefined
        // Values this build doesn't know: the level opens only after its confirm (§1.5.4).
        let newerValues:
            (() => Promise<RevisionWarning | 'unsupportedParts' | undefined>) | undefined
        await showModal(LoadingModal, {
            title: () => i18n.value.commands.open.title,
            async *task(signal: AbortSignal) {
                yield () => i18n.value.commands.open.loading

                const buffer = await file.arrayBuffer()
                signal.throwIfAborted()

                yield () => i18n.value.commands.open.importing
                await timeout(50)
                signal.throwIfAborted()

                const [type, data] = tryImport(buffer)
                let partial = false
                try {
                    switch (type) {
                        case 'chcy': {
                            const { offset, objects } = chcyToUsc(parseLevelData(data))

                            const chart = parseUscChart(objects)
                            validateChart(chart)

                            resetState(false, chart, offset, { sourceName: getFilename(file) })
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
                                applyLevelData(file, handle, buffer, levelData, chart, report)
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

                            resetState(false, chart, usc.offset, { sourceName: getFilename(file) })
                            break
                        }
                        case 'sus': {
                            const sus = parseSus(data)

                            const chart = parseSusChart(sus)
                            validateChart(chart)

                            resetState(false, chart, sus.offset, { sourceName: getFilename(file) })
                            break
                        }
                    }
                } catch (error) {
                    // A file its format's schema refuses is one the editor cannot read.
                    if (error instanceof AssertError) throw new UnsupportedFileError()
                    if (error instanceof ImportRefusal) throw new RefusedFileError(type, error)
                    throw error
                }

                opened(handle, buffer, type, partial)
            },
        })
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
            if (!choice) return
            warning = await apply()
            opened(handle, await file.arrayBuffer(), 'levelData', true)
        }
        if (!warning) return

        const message = warning
        void showModal(InfoModal, {
            title: () => i18n.value.commands.open.title,
            message: () =>
                message === 'unsupportedParts'
                    ? i18n.value.commands.open.unsupportedParts
                    : i18n.value.commands.open.revision[message],
        })
    },
}

/**
 * Opens parsed level data: a new session, with its handle and Export's target when it was read
 * whole (§1.4.8). Content this build did not read makes it partial: no file is written over (D2).
 */
const applyLevelData = async (
    file: File,
    handle: FileSystemFileHandle | undefined,
    buffer: ArrayBuffer,
    levelData: ReturnType<typeof parseLevelData>,
    chart: Chart,
    report: LevelDataReport,
): Promise<RevisionWarning | 'unsupportedParts' | undefined> => {
    const revisionWarning = getRevisionWarning(getLevelDataRevision(levelData.entities), chart)
    const complete = report.isEmpty
    resetState(false, chart, levelData.bgmOffset, { sourceName: getFilename(file) })
    setLevelDataHandle(complete ? handle : undefined)
    // Pickers then suggest "<name> (2)", never the original (§1.4.7).
    if (!complete) exportMemory.partial = true
    if (complete && isGzip(buffer)) {
        // Export's own format: its file is the remembered target (§1.4.8).
        exportMemory.sourceName = file.name
        if (handle)
            exportMemory.target = {
                name: handle.name,
                handle,
                disk: await levelDataDiskState(
                    new File([buffer], file.name, { lastModified: file.lastModified }),
                ),
                exported: false,
            }
    }
    return complete ? revisionWarning : 'unsupportedParts'
}

/** After an open: the source's bytes kept, the chain's Export fields stored, the notice. */
const opened = (
    handle: FileSystemFileHandle | undefined,
    buffer: ArrayBuffer,
    type: keyof typeof openedMessages,
    partial: boolean,
) => {
    // The source's bytes, so a save picker that empties it can be undone (D5).
    if (handle)
        exportMemory.opened = {
            handle,
            levelData: type === 'levelData',
            partial,
            // Complete level data may be written over; anything else is kept.
            bytes: type === 'levelData' && !partial ? undefined : buffer,
        }

    // The target and the partial flag are the new chain's (§1.4.8).
    rememberExport()
    // With Reopen while the session left can be reopened (Part 1 §1.4.1).
    notifyLeft(() => i18n.value.commands.open[openedMessages[type]])
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
