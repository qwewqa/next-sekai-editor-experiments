import type { LevelInfoTag } from '../../state/levelInfo'

// Level Info's Tags field: the titles in one comma-separated line.

/** The line the field shows for tags. */
export const tagsText = (tags: readonly LevelInfoTag[]) => tags.map((tag) => tag.title).join(', ')

/**
 * The tags a line gives. A line equal to `tagsText(old)` returns `old`, so a comma inside a title
 * stays. Otherwise the line is split on commas (also the full-width and ideographic ones that
 * Chinese and Japanese input methods type), trimmed, and its empty entries dropped.
 */
export const parseTags = (text: string, old: readonly LevelInfoTag[]): readonly LevelInfoTag[] =>
    text === tagsText(old)
        ? old
        : text
              .split(/[,，、､]/)
              .map((part) => part.trim())
              .filter((title) => title)
              .map((title) => ({ title }))
