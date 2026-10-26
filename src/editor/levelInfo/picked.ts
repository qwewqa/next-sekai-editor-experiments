import type { BatchMedia } from '../../local/flushWrite'
import { holdMedia } from '../../local/heldMedia'
import { captureMedia } from '../../local/media'
import { loadBgm } from '../../player'
import type { MediaRef } from '../../state/levelInfo'
import { TaskFailure } from '../../utils/error'
import { storeHeld } from '../media/heldBgm'

// A cover or preview audio picked in Level Info: its bytes are checked to be
// readable, then held by this tab before any step names them, so the flush
// that stores the step carries them in the same transaction.

export type MediaSlot = 'cover' | 'preview'

/** A picked file, or a utility's result. */
export type Source = { name: string; type: string; arrayBuffer: () => Promise<ArrayBuffer> }

/** What Cover Editor and Preview Editor hand back when opened from Level Info. */
export type UtilityResult = { blob: Blob; filename: string }

export type Picked = { ref: MediaRef; item: BatchMedia }

/** Checks a file is an image or audio the browser reads, and captures it. Unreadable files fail as the loading dialogs name them. */
export const capturePicked = async (slot: MediaSlot, file: Source): Promise<Picked> => {
    const data = await file.arrayBuffer()
    // Hashed and copied before decoding, which detaches the buffer.
    const captured = await captureMedia(data, file, slot === 'cover' ? 'image' : 'audio')
    if (slot === 'cover') {
        try {
            const bitmap = await createImageBitmap(new Blob([captured.source]))
            bitmap.close()
        } catch (error) {
            throw new TaskFailure('imageUnreadable', 'Failed to decode cover', { cause: error })
        }
    } else {
        await loadBgm(data)
    }
    const { hash, filename, size, type } = captured.meta
    return {
        ref: { hash, filename, size, type },
        item: { hash, bytes: captured.source, type, filename, kind: slot },
    }
}

/**
 * The file a "not loaded" slot names, picked again: held and stored at once under the recorded
 * name and type, with no edit.
 */
export const attachPicked = (picked: Picked, named: MediaRef) => {
    const item: BatchMedia = {
        ...picked.item,
        type: named.type || picked.item.type,
        filename: named.filename,
    }
    holdMedia(item)
    void storeHeld({ ...item, bytes: item.bytes.slice(0) })?.catch(() => undefined)
}
