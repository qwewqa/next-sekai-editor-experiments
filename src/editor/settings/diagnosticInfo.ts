import { SITE } from '../../buildInfo'
import { formatDiagnostics, ringEntries, type StoringFields } from '../../diagnostics'
import { appVersion, platform } from '../../platform'
import { PRODUCT_NAME } from '../../product'

/** How long the worker has to count its rows before the text goes without them. */
const COUNT_TIMEOUT_MS = 3000

/** What storing says about itself: its state, the worker's restarts, the database and its counts. */
const storingFacts = async (): Promise<StoringFields | undefined> => {
    const { storageWorker, storageStatus } = await import('../../local/start')
    if (!storageWorker) return
    const status = storageStatus.value
    const facts: StoringFields = {
        ...(status ? { mode: status.mode } : {}),
        ...(status?.reason ? { reason: status.reason } : {}),
        restarts: storageWorker.restartCount,
    }
    try {
        const { version, format, sessions, chains } = await storageWorker.call(
            'diagnostics',
            undefined,
            { timeoutMs: COUNT_TIMEOUT_MS },
        )
        if (version !== undefined)
            facts.database = {
                version,
                ...(format === undefined ? {} : { format }),
                sessions,
                chains,
            }
    } catch {
        // Storage may be paused, newer or gone: the text says the database is unavailable.
    }
    return facts
}

/** The text Copy Diagnostic Info… shows and copies (Part 1 §1.4.16); nothing is sent anywhere. */
export const collectDiagnosticText = async () => {
    const info = platform.diagnostics()
    let estimate: StorageEstimate | undefined
    try {
        estimate = await navigator.storage.estimate()
    } catch {
        // Not every browser can estimate.
    }
    const storing = await storingFacts().catch(() => undefined)
    return formatDiagnostics({
        productName: PRODUCT_NAME,
        appVersion: info.appVersion,
        atTag: appVersion().atTag,
        hasCommit: info.appVersion.includes('+'),
        site: SITE,
        engine: info.engine,
        os: info.os,
        standalone: info.standalone,
        userAgent: info.userAgent,
        estimate,
        ...(storing ? { storing } : {}),
        entries: ringEntries(),
    })
}
