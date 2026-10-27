/**
 * A command title as running text names it: without the ellipsis a label takes when its action
 * waits for an answer. Only a title that is itself the clickable label keeps it.
 */
export const withoutEllipsis = (title: string) => title.replace(/(…|\.\.\.)$/, '')
