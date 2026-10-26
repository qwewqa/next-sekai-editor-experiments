// A name from a file or a session is the user's data. Where it is shown inside a sentence it
// must stay on one line and must not reorder the words around it.

// Line breaks and the other control characters, each run as one space.
const CONTROLS = /[\p{Cc}\u2028\u2029]+/gu
// The explicit embeddings, overrides and isolates: an unpaired one reorders what follows it.
const EXPLICIT = /[\u202A-\u202E\u2066-\u2069]/g
// Right-to-left letters and marks, whose run would take the neighbouring neutrals with it.
const RIGHT_TO_LEFT =
    /[\u0590-\u08FF\u200F\u061C\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u

/**
 * A name as shown in a sentence, a title or a label: on one line, and, when it has right-to-left
 * text, isolated, so that text stays inside it. The first strong character picks its direction.
 * Every language of the app reads left to right, so a name with none needs no isolate.
 */
export const inlineName = (name: string) => {
    const plain = name.replace(CONTROLS, ' ').replace(EXPLICIT, '')
    return RIGHT_TO_LEFT.test(plain) ? `\u2068${plain}\u2069` : plain
}
