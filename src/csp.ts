// Logs Content Security Policy violations and calls the test hook (Step 1b adds the diagnostics ring).
export type CspViolation = {
    directive: string
    blocked: string
    sample: string
    source: string
    line: number
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
        // Tests set this to fail on a violation.
        const hook = Reflect.get(window, 'nseCspViolationHook') as unknown
        if (typeof hook === 'function') Reflect.apply(hook, window, [violation])
    },
    true,
)
