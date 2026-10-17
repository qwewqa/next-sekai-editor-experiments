// Logs Content Security Policy violations and calls the test hook (Step 1b adds the diagnostics ring).
export type CspViolation = {
    directive: string
    blocked: string
    sample: string
    source: string
    line: number
}

declare global {
    interface Window {
        /** Set by tests, which fail on a violation. */
        nseCspViolationHook?: (violation: CspViolation) => void
    }
}

document.addEventListener(
    'securitypolicyviolation',
    (event) => {
        const violation: CspViolation = {
            directive: event.effectiveDirective,
            blocked: event.blockedURI,
            sample: event.sample,
            source: event.sourceFile,
            line: event.lineNumber,
        }
        console.error('Content Security Policy violation', violation)
        window.nseCspViolationHook?.(violation)
    },
    true,
)
