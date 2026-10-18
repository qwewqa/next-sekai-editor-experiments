import type { MediaRef } from '../../state/levelInfo'
import { hashKey } from '../db'
import { equalBytes, fromHex16, sha256, toHex } from '../hash'
import type { MediaInput } from '../nxsp/build'
import { isObject } from '../nxsp/json'
import type { PinnedSource } from '../nxsp/plan'
import { NXSP_CAPS } from '../nxsp/read'
import type { SaveStore } from './bodies'

// The media rule (Part 1 §1.6.11.6, round 11 G3, owner A5): the head's BGM, cover and preview
// audio, each with its bytes when a source holds it (this tab's memory, the media store, or an
// append source's entry whose `sha256` begins with the head's hash) and as metadata only when none
// does. Media that has been replaced is never written. A stored Blob is re-hashed: one gone bad is
// damage in storage, a gap for this write, never a plan error.

export type MediaKind = 'bgm' | 'cover' | 'preview'

/** A media item this tab holds that storage may not: posted for the build. */
export type HeldMedia = { hash: string; bytes: Uint8Array; type: string; filename?: string }

export type MediaPlan = {
    input: MediaInput
    /** Written without its bytes: the "without its …" line. */
    without: boolean
    /** A stored copy failed its check: damage in storage. */
    damaged?: boolean
}

/** The project.json form of an append source's item, by kind. */
const sourceForm = (source: PinnedSource, kind: MediaKind) => {
    const project = source.projectJson
    if (!isObject(project)) return
    const form =
        kind === 'bgm'
            ? project.bgm
            : isObject(project.metadata)
              ? project.metadata[kind]
              : undefined
    return isObject(form) ? form : undefined
}

const fromSource = (source: PinnedSource, kind: MediaKind, ref: MediaRef) => {
    const form = sourceForm(source, kind)
    if (
        !form ||
        typeof form.file !== 'string' ||
        typeof form.sha256 !== 'string' ||
        !form.sha256.startsWith(ref.hash)
    )
        return
    const name = form.file.normalize('NFC')
    const matching = source.entries.filter((entry) => entry.name.normalize('NFC') === name)
    const [entry] = matching
    if (!entry || matching.length !== 1) return
    return { entry, sha256: form.sha256 }
}

const hex = (bytes: Uint8Array) => toHex(bytes)

/**
 * The plan of one media item the head uses. `held` is this tab's copy; the media store is read
 * and re-hashed next; then the append source's entry.
 */
export const planMediaItem = async (
    store: SaveStore,
    kind: MediaKind,
    ref: MediaRef,
    { held, source }: { held?: HeldMedia; source?: PinnedSource },
): Promise<MediaPlan> => {
    const filename = ref.filename
    const metadataOnly = (damaged?: boolean): MediaPlan => ({
        input: { hash: ref.hash, size: ref.size, type: ref.type, filename },
        without: true,
        ...(damaged ? { damaged } : {}),
    })
    if (ref.size > NXSP_CAPS.media) return metadataOnly()
    if (held?.hash === ref.hash) {
        const digest = await sha256(held.bytes)
        if (hex(digest).startsWith(ref.hash))
            return {
                input: {
                    bytes: held.bytes,
                    sha256: hex(digest),
                    type: ref.type || held.type,
                    filename,
                },
                without: false,
            }
    }
    let damaged = false
    const row = await store.read(['media'], (tx) => tx.get('media', hashKey(fromHex16(ref.hash))))
    if (isObject(row) && row.blob instanceof Blob) {
        try {
            const bytes = new Uint8Array(await row.blob.arrayBuffer())
            const digest = await sha256(bytes)
            const stored = row.sha256 instanceof Uint8Array ? row.sha256 : undefined
            if (hex(digest).startsWith(ref.hash) && (!stored || equalBytes(stored, digest)))
                return {
                    input: {
                        bytes,
                        sha256: hex(digest),
                        type: ref.type || (typeof row.type === 'string' ? row.type : ''),
                        filename,
                    },
                    without: false,
                }
            damaged = true
        } catch {
            damaged = true
        }
    }
    const copied = source && fromSource(source, kind, ref)
    if (source && copied)
        return {
            input: {
                copy: { source: source.token, entryIndex: copied.entry.index },
                sha256: copied.sha256,
                type: ref.type,
                filename,
            },
            without: false,
            ...(damaged ? { damaged } : {}),
        }
    return metadataOnly(damaged)
}
