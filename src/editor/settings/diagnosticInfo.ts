import { SITE } from '../../buildInfo'
import { formatDiagnostics, ringEntries } from '../../diagnostics'
import { appVersion, platform } from '../../platform'
import { PRODUCT_NAME } from '../../product'

/** The text Copy Diagnostic Info… shows and copies (Part 1 §1.4.16); nothing is sent anywhere. */
export const collectDiagnosticText = async () => {
    const info = platform.diagnostics()
    let estimate: StorageEstimate | undefined
    try {
        estimate = await navigator.storage.estimate()
    } catch {
        // Not every browser can estimate.
    }
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
        entries: ringEntries(),
    })
}
