import { holdMedia, releaseHeld } from '../../local/heldMedia'
import type { Picked } from './picked'

/**
 * The picks one Level Info dialog added to the held media, before any step names them. It
 * releases only those, and only the ones its caller says are unused: never a hash this tab held
 * before the dialog, and never one the dialog applied. Anything else stays held.
 */
export const trackHeldPicks = () => {
    const added = new Set<string>()
    return {
        /** Holds a pick for the flush and Save; the dialog owns it when the tab did not hold it before. */
        hold(picked: Picked) {
            if (holdMedia(picked.item)) added.add(picked.ref.hash)
        },
        /** A step already names the hash: it is no longer the dialog's to release. */
        adopt(hash: string) {
            added.delete(hash)
        },
        /** Releases the dialog's picks that `keep` refuses, such as one the draft replaced. */
        release(keep: (hash: string) => boolean) {
            for (const hash of [...added]) {
                if (keep(hash)) continue
                added.delete(hash)
                releaseHeld(hash)
            }
        },
        /** The dialog applied its draft: its picks stay held. */
        applied() {
            added.clear()
        },
    }
}
