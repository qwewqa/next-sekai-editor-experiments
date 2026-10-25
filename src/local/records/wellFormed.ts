// Lone surrogates become U+FFFD before text reaches a state, record, row or file.
// `String.prototype.toWellFormed` arrived after the Firefox 105 target.
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** The string with every lone surrogate replaced by U+FFFD. */
export const toWellFormed = (text: string) => text.replace(loneSurrogate, '\uFFFD')
