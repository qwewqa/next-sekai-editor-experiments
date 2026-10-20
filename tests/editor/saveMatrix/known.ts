import type { Violation } from './invariants'
import type { CellResult } from './matrix'

// The violations the matrix finds on today's tree (B0 report). Each is a `todo` test in the
// matrix files: it fails today and turns green when the design in architecture-review.md §B fixes
// it. A violation not named here fails the matrix, so a regression or a new finding cannot pass
// unnoticed. `by-design` marks what the plan documents (an unfinished read is dropped, R2) but the
// invariant, read strictly, still forbids.

export type Known = {
    id: string
    kind: 'bug' | 'by-design'
    title: string
    /** The paths whose cells show it. */
    paths: string[]
    invariant: string
    fault: string
}

export const KNOWN: Known[] = [
    {
        id: 'AR-6',
        kind: 'bug',
        title: 'Save to File… opens its picker while the open session’s import runs',
        paths: ['save-to-file'],
        invariant: 'I5',
        fault: 'import-picker-while-running',
    },
    {
        id: 'EX-I5',
        kind: 'bug',
        title: 'Export opens its picker with an import pending that never started',
        paths: ['export', 'export/reloaded'],
        invariant: 'I5',
        fault: 'import-pending-never-starts',
    },
    {
        id: 'EX-I4',
        kind: 'bug',
        title: 'Export opens its picker on an activation its own build outlasted',
        paths: ['export', 'export/reloaded', 'export/ahead'],
        invariant: 'I4',
        fault: 'activation-lapsed-export-build',
    },
    {
        id: 'R2-stale',
        kind: 'bug',
        title: 'the read first is stale: bytes written between the read and the pick are emptied and lost',
        paths: [
            'save-as',
            'save-as/reloaded',
            'save-as/ahead',
            'separate',
            'export',
            'export/reloaded',
            'export/ahead',
        ],
        invariant: 'I1',
        fault: 'read-stale',
    },
    {
        id: 'R2-slow',
        kind: 'by-design',
        title: 'a read first that has not settled when the picker opens is dropped, and the file is written from storage',
        paths: [
            'save-as',
            'save-as/reloaded',
            'save-as/ahead',
            'separate',
            'export',
            'export/reloaded',
            'export/ahead',
        ],
        invariant: 'I1',
        fault: 'read-slow',
    },
    {
        id: 'WB-throw',
        kind: 'bug',
        title: 'a write-back whose chain record cannot be read ends silently',
        paths: ['write-back'],
        invariant: 'flow threw',
        fault: 'worker-record-fails',
    },
]

export const isKnown = (cell: CellResult, violation: Violation) =>
    KNOWN.some(
        (known) =>
            known.invariant === violation.invariant &&
            known.fault === cell.fault &&
            known.paths.includes(cell.path),
    )
