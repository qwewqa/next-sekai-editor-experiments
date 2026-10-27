declare const __NSE_SITE__: string

// Release builds read only the test keys the production specs need: `nse.test.version`,
// `nse.test.storage` and `nse.test.startBlank`. Every other `nse.test.*` read is behind this flag,
// so a release bundle has none of them and each behaves as an absent key. Dev builds, the test
// site and Node tests (no import.meta.env, no build define) read them all. The define is read
// here, not through buildInfo, so the minifier sees a constant.
export const testKeysOpen =
    (import.meta as { env?: { DEV?: boolean } }).env?.DEV !== false ||
    typeof __NSE_SITE__ !== 'string' ||
    __NSE_SITE__ === 'test'

/**
 * A product timing window in ms, or `normal`: a spec widens or shortens it through the
 * `nse.test.*` key it names. Read on each use. Callers read it behind `testKeysOpen`, so a
 * release bundle does not name the key.
 */
export const testWindowMs = (key: string, normal: number) => {
    try {
        const set = localStorage.getItem(key)
        const ms = set === null ? Number.NaN : Number(set)
        return Number.isFinite(ms) && ms >= 0 ? ms : normal
    } catch {
        return normal
    }
}
