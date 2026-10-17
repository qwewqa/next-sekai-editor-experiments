import { ungzip } from 'pako'
import { AssertError } from 'typebox/value'
import type { Command } from '..'
import { parseLevelDataChart } from '../../../chart/parse/levelData'
import { parseSusChart } from '../../../chart/parse/sus'
import { parseUscChart } from '../../../chart/parse/usc'
import { ImportRefusal } from '../../../chart/refusal'
import { validateChart } from '../../../chart/validate'
import { chcyToUsc, isChcyLevelData } from '../../../chcy/convert'
import { detectHead } from '../../../files/detect'
import { checkState, resetState } from '../../../history'
import { i18n } from '../../../i18n'
import { parseLevelData } from '../../../levelData/parse'
import { LevelDataReport } from '../../../levelData/report'
import {
    getLevelDataRevision,
    getRevisionWarning,
    type RevisionWarning,
} from '../../../levelData/revision'
import { showModal } from '../../../modals'
import InfoModal from '../../../modals/InfoModal.vue'
import LoadingModal from '../../../modals/LoadingModal.vue'
import { levelDataDiskState } from '../../../platform'
import { parseSus } from '../../../sus/parse'
import { parseUsc } from '../../../usc/parse'
import { getFilename, pickFileForOpen } from '../../../utils/file'
import { interpolateRaw } from '../../../utils/interpolate'
import { timeout } from '../../../utils/promise'
import { notify } from '../../notification'
import { changeBgm } from '../bgm/index.ts'
import { exportMemory } from '../exportLevel/memory'
import { installDropGuard } from './dropGuard'
import OpenIcon from './OpenIcon.vue'

installDropGuard()

export const open: Command = {
    title: () => i18n.value.commands.open.title,
    icon: {
        is: OpenIcon,
    },

    async execute() {
        if (!(await checkState())) return

        const { file, handle } = await pickFileForOpen('levelData')
        if (!file) return

        // A failed read here surfaces in the loading modal below. A ZIP is only recognised for now.
        const detected = await detectHead(file).catch(() => 'data' as const)
        if (detected === 'audio') {
            void changeBgm(file)
            return
        }

        let warning: RevisionWarning | 'unsupportedParts' | undefined
        await showModal(LoadingModal, {
            title: () => i18n.value.commands.open.title,
            async *task(signal: AbortSignal) {
                yield () => i18n.value.commands.open.loading

                // Project files, archives and packages have no message of their own yet.
                if (detected === 'zip') throw new UnsupportedFileError()

                const buffer = await file.arrayBuffer()
                signal.throwIfAborted()

                yield () => i18n.value.commands.open.importing
                await timeout(50)
                signal.throwIfAborted()

                const [type, data] = tryImport(buffer)
                try {
                    switch (type) {
                        case 'chcy': {
                            const { offset, objects } = chcyToUsc(parseLevelData(data))

                            const chart = parseUscChart(objects)
                            validateChart(chart)

                            resetState(false, chart, offset, getFilename(file))
                            break
                        }
                        case 'levelData': {
                            const levelData = parseLevelData(data)

                            // An unknown choice value still refuses the open (its confirm is Step 6's).
                            const report = new LevelDataReport()
                            const chart = parseLevelDataChart(
                                levelData.entities,
                                undefined,
                                undefined,
                                report,
                            )
                            report.refuseUnknownValues()
                            validateChart(chart)
                            const revisionWarning = getRevisionWarning(
                                getLevelDataRevision(levelData.entities),
                                chart,
                            )

                            // Content this build did not read: no file is written over (D2).
                            const complete = report.isEmpty
                            resetState(
                                false,
                                chart,
                                levelData.bgmOffset,
                                getFilename(file),
                                complete ? handle : undefined,
                            )
                            warning = complete ? revisionWarning : 'unsupportedParts'
                            if (complete && isGzip(buffer)) {
                                // Export's own format: its file is the remembered target (§1.4.8).
                                exportMemory.sourceName = file.name
                                if (handle)
                                    exportMemory.target = {
                                        name: handle.name,
                                        handle,
                                        disk: await levelDataDiskState(
                                            new File([buffer], file.name, {
                                                lastModified: file.lastModified,
                                            }),
                                        ),
                                        exported: false,
                                    }
                            }
                            break
                        }
                        case 'usc': {
                            const { usc } = parseUsc(data)

                            const chart = parseUscChart(usc.objects)
                            validateChart(chart)

                            resetState(false, chart, usc.offset, getFilename(file))
                            break
                        }
                        case 'sus': {
                            const sus = parseSus(data)

                            const chart = parseSusChart(sus)
                            validateChart(chart)

                            resetState(false, chart, sus.offset, getFilename(file))
                            break
                        }
                    }
                } catch (error) {
                    // A file its format's schema refuses is one the editor cannot read.
                    if (error instanceof AssertError) throw new UnsupportedFileError()
                    if (error instanceof ImportRefusal) throw new RefusedFileError(type, error)
                    throw error
                }

                // The source's bytes, so a save picker that empties it can be undone (D5).
                if (handle)
                    exportMemory.opened = {
                        handle,
                        levelData: type === 'levelData',
                        bytes: type === 'levelData' ? undefined : buffer,
                    }

                notify(() => i18n.value.commands.open[openedMessages[type]])
            },
        })
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
