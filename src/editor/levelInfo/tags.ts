import type { LevelInfoTag } from '../../state/levelInfo'

// Level Info's Tags field (Part 1 §1.4.12): the titles in one comma-separated line.

/** The line the field shows for tags. */
export const tagsText = (tags: readonly LevelInfoTag[]) => tags.map((tag) => tag.title).join(', ')

/**
 * The tags a line stands for. A line equal to what `old` shows leaves `old` as it is (icons, order
 * and any comma inside a title). Otherwise the line is split on commas, trimmed, and its empty
 * entries dropped; a title found among `old` takes the first of those tags not yet used, with its
 * icon.
 */
export const parseTags = (text: string, old: readonly LevelInfoTag[]): readonly LevelInfoTag[] => {
    if (text === tagsText(old)) return old
    const used = new Set<number>()
    const tags: LevelInfoTag[] = []
    for (const part of text.split(',')) {
        const title = part.trim()
        if (!title) continue
        const at = old.findIndex((tag, i) => !used.has(i) && tag.title === title)
        const found = at < 0 ? undefined : old[at]
        if (found) {
            used.add(at)
            tags.push(found)
        } else tags.push({ title })
    }
    return tags
}
