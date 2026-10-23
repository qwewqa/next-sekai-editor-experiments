import type { State } from '../state'

// The displayed name (Part 1 §1.3.5): the first of the bound file's stem, the Name (only a copy's
// automatic "<name> (2)" is set now, so a copy saved as a file is named by it), the title,
// the imported file's stem (unless "LevelData", which names nothing), the BGM's stem, and the
// date fallback ("Untitled · Oct 16, 2:41 PM", formatted where it's shown).

/** What the displayed name is chosen from. */
export type NameParts = {
    name?: string
    /** The bound file's name. */
    fileName?: string
    title?: string
    sourceName?: string
    bgmName?: string
}

export type DisplayName =
    | { kind: 'name' | 'file' | 'title' | 'source' | 'bgm'; text: string }
    /** The date fallback: the session's start, formatted by the UI. */
    | { kind: 'date' }

/**
 * What a separate copy was made from (§1.3.1): the bound file's name, or the session's own name.
 * A chain with no name of its own has an empty `name` and the source's `at`, its start, which
 * names it as the date fallback is shown, "Untitled · Oct 16, 2:41 PM" (X-13).
 */
export type CopyOf = { readonly name: string; readonly bound: boolean; readonly at?: number }

/** The source of a copy of a session that is not bound to a file. */
export const sessionCopyOf = (name: string | undefined, at: number | undefined): CopyOf =>
    name ? { name, bound: false } : { name: '', bound: false, ...(at === undefined ? {} : { at }) }

/** A file name without its last extension. */
export const stemOf = (fileName: string) => {
    const dot = fileName.lastIndexOf('.')
    return dot > 0 ? fileName.slice(0, dot) : fileName
}

export const displayName = (parts: NameParts): DisplayName => {
    if (parts.fileName) return { kind: 'file', text: stemOf(parts.fileName) }
    if (parts.name) return { kind: 'name', text: parts.name }
    if (parts.title) return { kind: 'title', text: parts.title }
    if (parts.sourceName && parts.sourceName !== 'LevelData')
        return { kind: 'source', text: parts.sourceName }
    if (parts.bgmName) return { kind: 'bgm', text: stemOf(parts.bgmName) }
    return { kind: 'date' }
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

/** The parts of a chain record (or a journal's descriptor) and the state it shows. */
export const namePartsOf = (chain: Record<string, unknown> | undefined, state?: State) => {
    const file = chain?.file as { name?: unknown } | undefined
    const parts: NameParts = {}
    const name = text(chain?.name)
    const fileName = text(file?.name)
    const summary = chain?.summary as { title?: unknown; bgmName?: unknown } | undefined
    const title = text(state?.levelInfo.title) ?? text(summary?.title)
    const sourceName = text(chain?.sourceName)
    // A stored chain has no state here: its summary keeps the BGM's name.
    const bgmName = state
        ? (text(state.bgm.meta?.filename) ?? text(state.bgm.filename))
        : text(summary?.bgmName)
    if (name) parts.name = name
    if (fileName) parts.fileName = fileName
    if (title) parts.title = title
    if (sourceName) parts.sourceName = sourceName
    if (bgmName) parts.bgmName = bgmName
    return parts
}

// A copy number: " (2)" to " (99)" at the end. "Song (2020)" has none, so its copy is
// "Song (2020) (2)", never "Song (2021)".
const COPY_NUMBER = / \((\d{1,2})\)$/

/** Whether a name ends in a copy number, " (2)". */
export const hasCopyNumber = (name: string) => COPY_NUMBER.test(name)

/** The next copy's name: "Coconut (3)" after "Coconut (2)", else "Coconut (2)" (§1.3.1). */
export const nextCopyName = (name: string) => {
    const match = COPY_NUMBER.exec(name)
    return match ? `${name.slice(0, match.index)} (${Number(match[1]) + 1})` : `${name} (2)`
}

/** A fork's name, "<name> (2)" (§1.3.1); none when the displayed name is the date fallback. */
export const forkNameOf = (parts: NameParts) => {
    const shown = displayName(parts)
    return shown.kind === 'date' ? undefined : nextCopyName(shown.text)
}

/**
 * The name a chain takes when it loses its file (§1.3.5): the file's stem, over any name it had.
 * Every web name is automatic, and the file name is the one the user chose last, by saving.
 */
export const keptNameOf = (name: unknown, fileName: unknown) =>
    text(fileName) ? stemOf(fileName as string) : text(name)

/**
 * The displayed name as a file name (§1.4.7's prefill): as shown, since the shown name is already a
 * stem; empty for the date fallback and for "LevelData", which names nothing.
 */
export const prefillOf = (shown: DisplayName) =>
    shown.kind === 'date' || shown.text === 'LevelData' ? '' : shown.text
