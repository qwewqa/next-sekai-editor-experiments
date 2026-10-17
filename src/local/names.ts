import type { State } from '../state'

// The displayed name (Part 1 §1.3.5): the first of the Name, the bound file's stem, the title,
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

/** A file name without its last extension. */
export const stemOf = (fileName: string) => {
    const dot = fileName.lastIndexOf('.')
    return dot > 0 ? fileName.slice(0, dot) : fileName
}

export const displayName = (parts: NameParts): DisplayName => {
    if (parts.name) return { kind: 'name', text: parts.name }
    if (parts.fileName) return { kind: 'file', text: stemOf(parts.fileName) }
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
    const title = text(state?.levelInfo.title)
    const sourceName = text(chain?.sourceName)
    const bgmName = text(state?.bgm.meta?.filename) ?? text(state?.bgm.filename)
    if (name) parts.name = name
    if (fileName) parts.fileName = fileName
    if (title) parts.title = title
    if (sourceName) parts.sourceName = sourceName
    if (bgmName) parts.bgmName = bgmName
    return parts
}

/** A fork's name, "<name> (2)" (§1.3.1); none when the displayed name is the date fallback. */
export const forkNameOf = (parts: NameParts) => {
    const shown = displayName(parts)
    return shown.kind === 'date' ? undefined : `${shown.text} (2)`
}
