// The agreement record the harness seeds: revisions above any build's, so every page counts as
// agreed, and raising a page's revision never touches the harness. In-page init scripts repeat the
// literal. The gate's own specs remove it.

/** The record's localStorage key. */
export const AGREEMENT_KEY = 'sonolus-next-sekai-editor.agreement'

/** The seeded record. */
export const AGREED = JSON.stringify({ terms: 999, privacy: 999 })
