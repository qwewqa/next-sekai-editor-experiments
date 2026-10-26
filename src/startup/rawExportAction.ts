import { recordError } from '../diagnostics'
import { i18n } from '../i18n'
import { appVersion, platform } from '../platform'
import { setRawExport } from './gate'
import { rawExportName, rawExportNote, type RawExportRun } from './rawExportNote'
import { runRawExport } from './rawExportRun'

// Export Raw Data as the page runs it: the gate's error state and Settings ›
// Local Data both use it. The export module loads when it is used.

export const runRawExportAction = async (signal?: AbortSignal): Promise<RawExportRun> => {
    const { exportRawData } = await import('../local/rawExport')
    return runRawExport(
        {
            exportRawData,
            appVersion: appVersion().appVersion,
            name: rawExportName(i18n.value.settings.localData.exportRawName),
            saveFile: (request) => platform.saveFile(request),
        },
        signal,
    )
}

/** Registers the gate's Export Raw Data (the error state offers it). */
export const registerGateRawExport = () => {
    setRawExport({
        label: () => i18n.value.settings.localData.exportRaw,
        run: async () => {
            const texts = {
                downloadFailed: i18n.value.save.downloadFailed,
                unreadable: i18n.value.settings.localData.exportRawUnreadable,
            }
            try {
                return rawExportNote(await runRawExportAction(), texts)
            } catch (error) {
                // The export code did not load: the note for an export that failed, with the name
                // it would have had.
                recordError(error)
                return rawExportNote(
                    {
                        kind: 'failed',
                        name: rawExportName(i18n.value.settings.localData.exportRawName),
                        error,
                    },
                    texts,
                )
            }
        },
    })
}
