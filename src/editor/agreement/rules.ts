// When the agreement dialog is due, and what Agree stores: the rules, kept apart from the browser
// state they read, so they can be tested alone.

/** The localStorage key of the revisions of the Terms of Service and Privacy Notice agreed to. */
export const AGREEMENT_KEY = 'agreement'

export type Revisions = { terms: number; privacy: number }

const whole = (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0

/**
 * The stored record. A field that is not a whole number of 0 or more reads as 0, and a value that
 * is not an object reads as no record.
 */
export const recordOf = (stored: unknown): Revisions | undefined => {
    if (typeof stored !== 'object' || stored === null) return undefined
    const { terms, privacy } = stored as Record<string, unknown>
    return { terms: whole(terms), privacy: whole(privacy) }
}

/** The revisions this build asks the user to agree to; none unless the build has both pages. */
export const asked = (pages: { terms?: number; privacy?: number }): Revisions | undefined =>
    pages.terms !== undefined && pages.privacy !== undefined
        ? { terms: pages.terms, privacy: pages.privacy }
        : undefined

/** Due when the build asks and the record is missing or below either page's revision. */
export const isDue = (current?: Revisions, record?: Revisions) =>
    !!current && (!record || record.terms < current.terms || record.privacy < current.privacy)

/** Which page changed since the record, for the line at the top; none on a first agreement. */
export const changeOf = (
    current: Revisions,
    record?: Revisions,
): 'terms' | 'privacy' | 'both' | undefined => {
    if (!record) return undefined
    const terms = record.terms < current.terms
    const privacy = record.privacy < current.privacy
    return terms && privacy ? 'both' : terms ? 'terms' : privacy ? 'privacy' : undefined
}

/** What Agree stores: per page, the higher of the record and this build, so none goes down. */
export const agreed = (current: Revisions, record?: Revisions): Revisions => ({
    terms: Math.max(record?.terms ?? 0, current.terms),
    privacy: Math.max(record?.privacy ?? 0, current.privacy),
})
