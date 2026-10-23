import { i18n } from '../i18n'
import { appVersion, platform } from '../platform'
import { setRawExport } from './gate'
import { rawExportNote, type RawExportRun } from './rawExportNote'

// Export Raw Data… as the page runs it (Part 1 §1.4.14): the gate's error state and Settings ›
// Local Data both use it. The export module loads when it is used.

export const runRawExportAction = async (): Promise<RawExportRun> => {
    const { exportRawData, rawExportName } = await import('../local/rawExport')
    const name = rawExportName(i18n.value.settings.localData.exportRawName)
    let size = 0
    let started = false
    try {
        const { databaseUnreadable } = await exportRawData(
            appVersion().appVersion,
            name,
            async (suggestedName, blob) => {
                size = blob.size
                const result = await platform.saveFile({
                    kind: 'recovery',
                    suggestedName,
                    build: () => Promise.resolve(blob),
                })
                started = result.status === 'download-started'
            },
        )
        return { kind: 'done', name, size, started, databaseUnreadable }
    } catch (error) {
        console.error(error)
        return { kind: 'failed', name, error }
    }
}

/** Registers the gate's Export Raw Data… (the error state offers it). */
export const registerGateRawExport = () => {
    setRawExport({
        label: () => i18n.value.settings.localData.exportRaw,
        run: async () =>
            rawExportNote(await runRawExportAction(), {
                downloadFailed: i18n.value.save.downloadFailed,
                unreadable: i18n.value.settings.localData.exportRawUnreadable,
            }),
    })
}
