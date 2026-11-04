// Lone surrogates become U+FFFD before text reaches a state, record, row or file.

/** The string with every lone surrogate replaced by U+FFFD. */
export const toWellFormed = (text: string) => text.toWellFormed()
