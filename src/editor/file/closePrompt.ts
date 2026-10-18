import { isDirty } from '../../history'
import { flusher, isDurablyStored } from '../../local/storing'
import { platform } from '../../platform'
import { settings } from '../../settings'
import { boundFile, downloadNotConfirmed, fileChanged } from './state'

// The page-close prompt (Part 1 §1.4.9): the browser's own, with no text of ours. A session that
// isn't durably stored and has edits always prompts; one with changes not in a file prompts when
// the setting is on.

/**
 * Whether the open session has changes not in a file (§1.4.9): bound and changed since its file
 * event, bound by a download that isn't confirmed, or unbound with edits. A chain whose file a
 * save picker took over counts as unbound and edited (its `edited` flag is set then).
 */
export const hasChangesNotInFile = () => {
    if (boundFile.value) return fileChanged.value || downloadNotConfirmed.value
    const stored = flusher?.session
    // Before storing starts, or in safe mode, the slot's flag stands in.
    return stored ? stored.edited : isDirty.value
}

/** Whether leaving now loses edits no store holds. */
const losesEdits = () => {
    const stored = flusher?.session
    if (!stored) return isDirty.value
    return stored.edited && isDirty.value && !isDurablyStored()
}

platform.onCloseRequested(
    () => !(losesEdits() || (settings.confirmCloseUnsavedFile && hasChangesNotInFile())),
)
