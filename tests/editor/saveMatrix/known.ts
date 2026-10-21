import type { Violation } from './invariants'
import type { CellResult } from './matrix'

// The violations the matrix finds on today's tree: the residuals the owner or lead ruled acceptable
// (work/arch/spec-B.md, sections 2 and 5). Each is a `todo` test in the matrix files that stays, so
// it is visible. A violation not named here fails the matrix, so a regression or a new finding
// cannot pass unnoticed.

export type Known = {
    id: string
    kind: 'accepted'
    title: string
    /** The paths whose cells show it. */
    paths: string[]
    invariant: string
    fault: string
    /** The pick plans that show it; absent for every plan of the paths. */
    plans?: string[]
    /** When present, only a violation whose detail matches is this entry's. */
    detail?: RegExp
}

export const KNOWN: Known[] = [
    {
        id: 'R2-stale',
        kind: 'accepted',
        title: 'the read first is stale: bytes written between the read and the pick are emptied and lost',
        paths: [
            'save-as',
            'save-as/reloaded',
            'save-as/ahead',
            'separate',
            'save-to-file',
            'export',
            'export/reloaded',
            'export/ahead',
        ],
        invariant: 'I1',
        fault: 'read-stale',
    },
    {
        id: 'R8-owners',
        kind: 'accepted',
        title: 'storage fails when the pick is identified: the owners are unread, so another chain keeps its binding, or its Export target, on a file that now holds this chain’s project',
        paths: [
            'save-first',
            'save-as',
            'save-as/reloaded',
            'save-as/stored',
            'save-as/ahead',
            'separate',
            'notfound-saveas',
        ],
        invariant: 'I9',
        fault: 'identify-fails',
        plans: ['other', 'target'],
        detail: /is bound to chain-other and chain-own|is chain-target’s Export target/,
    },
    {
        id: 'R8-kept',
        kind: 'accepted',
        title: 'storage fails when the pick is identified after a reload: the partial open’s file is unknown to this tab, and is written over',
        paths: ['save-as/reloaded', 'export/reloaded'],
        invariant: 'I1',
        fault: 'identify-fails',
        plans: ['partial'],
        detail: /^opened.nsld held/,
    },
]

export const isKnown = (cell: CellResult, violation: Violation) =>
    KNOWN.some(
        (known) =>
            known.invariant === violation.invariant &&
            known.fault === cell.fault &&
            known.paths.includes(cell.path) &&
            (known.plans?.includes(cell.plan) ?? true) &&
            (known.detail?.test(violation.detail) ?? true),
    )
