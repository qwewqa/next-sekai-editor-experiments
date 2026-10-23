import type { State } from '../../state'
import type { LevelInfo, MediaRef } from '../../state/levelInfo'
import { parseTags, tagsText } from './tags'

// The Level Info dialog's draft (Part 1 §1.4.12): what the form holds, the values it opened with,
// and the fields an Apply writes (`apply.ts` pushes the step).

export type Draft = {
    title: string
    artists: string
    author: string
    description: string
    rating: number | undefined
    /** The tags' titles in one comma-separated line. */
    tags: string
    cover: MediaRef | undefined
    preview: MediaRef | undefined
    life: number
}

/** The form's values for a state's level info and Initial Life. */
export const draftOf = (info: LevelInfo, life: number): Draft => ({
    title: info.title,
    artists: info.artists,
    author: info.author,
    description: info.description,
    rating: info.rating,
    tags: tagsText(info.tags),
    cover: info.cover,
    preview: info.preview,
    life,
})

/** Whether two files are the same content under the same name: either is a change otherwise. */
const sameFile = (a: MediaRef | undefined, b: MediaRef | undefined) =>
    a?.hash === b?.hash && a?.filename === b?.filename

/** The fields that differ between the values the dialog opened with and its draft. */
export const changedFields = (opening: Draft, draft: Draft) => {
    const same = (field: keyof Draft) =>
        field === 'cover' || field === 'preview'
            ? sameFile(opening[field], draft[field])
            : opening[field] === draft[field]
    return (Object.keys(opening) as (keyof Draft)[]).filter((field) => !same(field))
}

/** The level info and Initial Life an Apply makes: the changed fields laid over `live`. */
export const draftOver = (opening: Draft, draft: Draft, live: State) => {
    const changed = new Set(changedFields(opening, draft))
    const info = live.levelInfo
    const text = (field: 'title' | 'artists' | 'author' | 'description') =>
        changed.has(field) ? draft[field] : info[field]
    const rating = changed.has('rating') ? draft.rating : info.rating
    const cover = changed.has('cover') ? draft.cover : info.cover
    const preview = changed.has('preview') ? draft.preview : info.preview
    const levelInfo: LevelInfo = {
        title: text('title'),
        artists: text('artists'),
        author: text('author'),
        description: text('description'),
        tags: changed.has('tags') ? parseTags(draft.tags, info.tags) : info.tags,
        ...(cover ? { cover } : {}),
        ...(preview ? { preview } : {}),
        ...(rating === undefined ? {} : { rating }),
    }
    return { levelInfo, life: changed.has('life') ? draft.life : live.initialLife }
}
