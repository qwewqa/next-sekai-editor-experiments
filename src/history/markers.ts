import { interpolate } from '../utils/interpolate'
import { markFileEvent } from './stack'

// The file events' entries (Part 1 §1.3.8): Save's and Export Level Data…'s, on the live state,
// leaving the stack alone. Their labels are evaluated when flushed, in the locale then (§1.10 #7).

type Messages = { entry: { exported: string; saved: string; downloaded: string } }

let messages: () => Messages = () => {
    throw new Error('No messages for file events yet')
}

/** Where the labels come from: the app's i18n, set once at startup. */
export const setFileEventMessages = (get: () => Messages) => {
    messages = get
}

/** Records an export of the live state: "Exported {0}". */
export const markExported = (fileName: string) => {
    markFileEvent(
        'export',
        interpolate(() => messages().entry.exported, fileName),
    )
}

/**
 * Records a save of the live state: "Saved {0}", or "Downloaded {0}" for a download. It's the
 * file event, so the entry isn't changed since it. Step 6 adds its `revisionId` and `device`.
 */
export const markSaved = (fileName: string, download: boolean) => {
    markFileEvent(
        'save',
        interpolate(
            () => (download ? messages().entry.downloaded : messages().entry.saved),
            fileName,
        ),
        false,
    )
}
