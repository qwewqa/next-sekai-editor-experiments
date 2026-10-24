/**
 * A media item a state names by content, whether or
 * not any store holds its bytes: the first 16 bytes of its SHA-256 as hex.
 */
export type MediaRef = {
    readonly hash: string
    /** The picked file's name, or "" when unknown. */
    readonly filename: string
    readonly size: number
    /** The MIME type sniffed from the bytes, or "". */
    readonly type: string
}

export type LevelInfoTag = { readonly title: string }

/** Level info: chart state, in the snapshot header. Empty strings are unset. */
export type LevelInfo = {
    readonly title: string
    readonly artists: string
    readonly author: string
    readonly description: string
    readonly tags: readonly LevelInfoTag[]
    readonly cover?: MediaRef
    readonly preview?: MediaRef
    readonly rating?: number
}

export const emptyLevelInfo: LevelInfo = Object.freeze({
    title: '',
    artists: '',
    author: '',
    description: '',
    tags: Object.freeze([]),
})
