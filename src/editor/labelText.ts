import { computed } from 'vue'
import { session } from '../history/session'
import { liveState } from '../history/stack'
import { i18n } from '../i18n'
import { languageTag } from '../i18n/plural'
import { formatWhen } from '../i18n/when'
import { displayName, namePartsOf, stemOf } from '../local/names'
import { settings } from '../settings'
import { interpolateRaw } from '../utils/interpolate'
import { diskFinding, fileChanged, fileEvent, writesInPlace } from './file/state'
import { shownName } from './shownName'

// The status bar's label and the page title (Part 1 §1.3.4): the displayed name, then the file
// the session is bound to or the reason it is not, and a "•" when the file has changes.

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
    return shownName({
        name: displayName(parts),
        ...(open.startedAt === undefined ? {} : { at: open.startedAt }),
    })
})

// A state fragment of a line joined with " · " is lower case (§1.4.19), unless it opens with a
// name: only the first letter, and never a name's.
const fragment = (text: string) =>
    text.startsWith('{')
        ? text
        : text.charAt(0).toLocaleLowerCase(languageTag(settings.locale)) + text.slice(1)

/**
 * A `file.*` string as a joined fragment: "{0} · downloaded {1}" without its name, "downloaded
 * Oct 14" (§1.3.4): the time when the event was today, the date otherwise. Undefined when the
 * event's time is not known: the fragment is left out.
 */
const eventFragment = (template: string, at: number | undefined) =>
    at === undefined
        ? undefined
        : interpolateRaw(template.replace(/^\{0\} · /, ''), '', formatWhen(at))

export type StatusLabel = {
    /** The displayed name, or empty when the file's name stands for it. */
    name: string
    /** The bound file's name, in a muted style. */
    file?: string
    /** Why it is not bound ("not saved to a file", "separate copy of …"), or what a bound file's check found. */
    state?: string
    /** Whether the bound file has changes (the "•"). */
    changed: boolean
}

const diskFragment = () => {
    const { state } = i18n.value
    const kind = diskFinding.value
    if (kind === 'missing') return fragment(state.fileMissing)
    if (kind === 'changed') return fragment(state.changedOnDisk)
    if (kind === 'newer') return fragment(state.newerOnDisk)
}

export const statusLabel = computed((): StatusLabel => {
    const open = session.value
    const name = displayedName.value
    if (open.file) {
        // The file Save writes to is always on screen: the bare name when it is the stem.
        const stem = stemOf(open.file.name) === name
        const { file: strings } = i18n.value
        // A download browser adds the state: Save there downloads a new copy, it writes no file.
        const event = writesInPlace()
            ? undefined
            : fileEvent.value === 'opened'
              ? eventFragment(strings.opened, open.file.at)
              : eventFragment(strings.downloaded, open.file.at)
        const state = [event, diskFragment()].filter(Boolean).join(' · ')
        return {
            name: stem ? '' : name,
            file: open.file.name,
            ...(state ? { state } : {}),
            changed: fileChanged.value,
        }
    }
    if (open.copyOf)
        return {
            name,
            // An untitled source is the copy's own date name already; the label says only "copy".
            state: open.copyOf.name
                ? interpolateRaw(fragment(i18n.value.status.separateCopy), open.copyOf.name)
                : fragment(i18n.value.status.separateCopyShort),
            changed: false,
        }
    return { name, state: fragment(i18n.value.status.notInFile), changed: false }
})

/** The label as one line, joined with " · ", with the "•" when the file has changes. */
export const statusText = computed(() => {
    const { name, file, state, changed } = statusLabel.value
    const line = [name, file, state].filter(Boolean).join(' · ')
    return changed ? `${line} •` : line
})

/** The label's accessible name: "Coconut (Master), changed since coconut.nxsp was saved". */
export const statusName = computed(() => {
    const open = session.value
    const { status } = i18n.value
    if (!open.file || !fileChanged.value) return statusText.value
    const template =
        fileEvent.value === 'saved'
            ? status.changedSaved
            : fileEvent.value === 'opened'
              ? status.changedOpened
              : status.changedDownload
    return interpolateRaw(template, displayedName.value, open.file.name)
})
