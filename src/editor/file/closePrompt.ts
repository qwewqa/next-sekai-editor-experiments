import { isDirty } from '../../history'
import { platform } from '../../platform'
import { settings } from '../../settings'
import { boundFile, fileChanged } from './state'

// The page-close prompt: the browser's own, with no text of ours. A session that
// isn't durably stored and has edits always prompts; one with changes not in a file prompts when
// the setting is on.

// The storage modules load after first paint, so they are fetched when the page is idle.
// Until they are in, the slot's own flag stands in.
let storing: typeof import('../../local/storing') | undefined

/** Loads the storage modules now, for an in-app prompt, which reads them once this resolves. */
export const loadStoring = () => import('../../local/storing').then((module) => (storing = module))
const load = () => {
    void loadStoring()
}
if (typeof requestIdleCallback === 'function') requestIdleCallback(load, { timeout: 3000 })
else setTimeout(load, 1000)

/**
 * Whether the open session has edits no file holds, a download counting as the file: bound and
 * changed since its file event, or unbound with edits in its chain, an earlier visit's included.
 * A chain whose file a save picker took over counts as unbound and edited (its `edited` flag is
 * set then). New asks on it.
 */
export const hasEditsNotInFile = () => {
    if (boundFile.value) return fileChanged.value
    const stored = storing?.flusher?.session
    return stored ? stored.edited || stored.chain?.edited === true : isDirty.value
}

/** Whether leaving now loses edits no store holds. */
const losesEdits = () => {
    const stored = storing?.flusher?.session
    if (!stored) return isDirty.value
    return stored.edited && isDirty.value && !storing?.isDurablyStored()
}

platform.onCloseRequested(
    () => !(losesEdits() || (settings.confirmCloseUnsavedFile && hasEditsNotInFile())),
)
