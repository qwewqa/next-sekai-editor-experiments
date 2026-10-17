// Logs Content Security Policy violations, records them in the diagnostics ring and calls the test hook.
import { recordDiagnostic } from './diagnostics'

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
        recordDiagnostic(
            'csp',
            `${violation.directive} blocked ${violation.blocked}${violation.source ? ` at ${violation.source}:${violation.line}` : ''}`,
        )
        // Tests set this to fail on a violation.
        const hook = Reflect.get(window, 'nseCspViolationHook') as unknown
        if (typeof hook === 'function') Reflect.apply(hook, window, [violation])
    },
    true,
)
