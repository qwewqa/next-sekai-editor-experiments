/** The longest text, in UTF-16 code units, that a user can type or paste into each kind of field. */
export const textLimits = {
    /** Title, Artists, Author and the names of groups, stages and folders. */
    name: 512,
    /** The whole comma-separated Tags line. */
    tags: 4096,
    description: 32768,
}

/**
 * The `maxlength` for a field holding `value`. A longer value, such as an imported one, is kept
 * whole and can be shortened, but cannot grow.
 */
export const lengthLimit = (limit: number | undefined, value: string) =>
    limit === undefined ? undefined : Math.max(limit, value.length)
