import type { exportRawData } from '../local/rawExport'
import { isAbort } from '../platform/handover'
import type { Platform } from '../platform/types'
import type { RawExportRun } from './rawExportNote'

// The run of Export Raw Data, apart from the action so a Node test can read it.

/**
 * Builds the export and hands it over. `signal` is the Loading dialog's cancel. The build cannot
 * stop midway, so a cancel takes effect before the hand-over, and nothing is handed over once it
 * has fired.
 */
export const runRawExport = async (
    run: {
        exportRawData: typeof exportRawData
        appVersion: string
        name: string
        saveFile: Platform['saveFile']
    },
    signal?: AbortSignal,
): Promise<RawExportRun> => {
    const { name } = run
    let size = 0
    let started = false
    try {
        const { databaseUnreadable } = await run.exportRawData(
            run.appVersion,
            name,
            async (suggestedName, blob) => {
                signal?.throwIfAborted()
                size = blob.size
                const result = await run.saveFile({
                    kind: 'recovery',
                    suggestedName,
                    build: () => Promise.resolve(blob),
                    signal,
                })
                started = result.status === 'download-started'
            },
        )
        return { kind: 'done', name, size, started, databaseUnreadable }
    } catch (error) {
        // Cancelled only when the user's signal fired. An AbortError from the browser alone is a
        // failure.
        if (signal?.aborted && isAbort(error)) return { kind: 'cancelled' }
        console.error(error)
        return { kind: 'failed', name, error }
    }
}
