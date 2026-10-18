import { computed } from 'vue'
import { session } from '../history/session'
import { liveState } from '../history/stack'
import { i18n } from '../i18n'
import { languageTag } from '../i18n/plural'
import { displayName, namePartsOf, stemOf } from '../local/names'
import { settings } from '../settings'
import { interpolateRaw } from '../utils/interpolate'
import { shownName } from './shownName'

// The status bar's label and the page title (Part 1 §1.3.4): the displayed name, then the file
// the session is bound to or the reason it is not. File states ("changed since saved" and the
// "•") come with Step 6's file events.

/** The displayed name (§1.3.5) of the open session. */
export const displayedName = computed(() => {
    const open = session.value
    const parts = namePartsOf(
        {
            name: open.name,
            sourceName: open.sourceName,
            ...(open.file ? { file: { name: open.file.name } } : {}),
        },
        liveState.value,
    )
    return shownName({ name: displayName(parts), at: open.startedAt ?? 0 })
})

// A state fragment of a line joined with " · " is lower case (§1.4.19), unless it opens with a
// name: only the first letter, and never a name's.
const fragment = (text: string) =>
    text.startsWith('{')
        ? text
        : text.charAt(0).toLocaleLowerCase(languageTag(settings.locale)) + text.slice(1)

export type StatusLabel = {
    /** The displayed name, or empty when the file's name stands for it. */
    name: string
    /** The bound file's name, in a muted style. */
    file?: string
    /** Why it is not bound: "not saved to a file", "separate copy of …". */
    state?: string
}

export const statusLabel = computed((): StatusLabel => {
    const open = session.value
    const name = displayedName.value
    if (open.file) {
        // The file Save writes to is always on screen: the bare name when it is the stem.
        const stem = stemOf(open.file.name) === name
        return { name: stem ? '' : name, file: open.file.name }
    }
    if (open.copyOf)
        return {
            name,
            state: interpolateRaw(fragment(i18n.value.status.separateCopy), open.copyOf.name),
        }
    return { name, state: fragment(i18n.value.status.notInFile) }
})

/** The label as one line, joined with " · ". */
export const statusText = computed(() => {
    const { name, file, state } = statusLabel.value
    return [name, file, state].filter(Boolean).join(' · ')
})
