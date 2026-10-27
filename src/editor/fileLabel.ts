import { i18n } from '../i18n'
import { languageTag } from '../i18n/plural'
import { formatWhen } from '../i18n/when'
import { stemOf } from '../local/names'
import { settings } from '../settings'
import { inlineName } from '../utils/inlineName'
import { interpolateRaw } from '../utils/interpolate'

// The file part of a session's label, from plain inputs: the status bar calls it
// with the open session's and a Recent Sessions row with a chain's. A row leaves out the file event
// (`showEvent`); the rest is the same.

/** The bound file as the label shows it: `event` is 'saved', 'downloaded' or 'opened' (else a download). */
export type LabelFile = { name: string; event?: string; at?: number }

export type StatusLabel = {
    /** The displayed name, or empty when the file's name stands for it. */
    name: string
    /** The bound file's name, in a muted style. */
    file?: string
    /** Why it is not bound ("unsaved", "separate copy of …"), or what a bound file's check found. */
    state?: string
    /** Whether the bound file has changes (the "•"). */
    changed: boolean
}

export type LabelInput = {
    /** The displayed name, as shown (the date fallback included). */
    name: string
    file?: LabelFile
    /** Whether the bound file has changes. */
    changed: boolean
    /** What a separate copy was made from; a stored chain does not know it. */
    copyOf?: { name: string }
    /** What a check found on disk; a list does not check. */
    diskFinding?: 'missing' | 'changed' | 'newer'
    /** Whether the label names the file event: the status bar does in a download browser, a row never. */
    showEvent: boolean
}

// A state fragment of a line joined with " · " is lower case, unless it opens with a
// name: only the first letter, and never a name's.
export const fragment = (text: string) =>
    text.startsWith('{')
        ? text
        : text.charAt(0).toLocaleLowerCase(languageTag(settings.locale)) + text.slice(1)

/**
 * A `file.*` string as a joined fragment: "{0} · downloaded {1}" without its name, "downloaded
 * Oct 14": the time when the event was today, the date otherwise. Undefined when the
 * event's time is not known: the fragment is left out.
 */
const eventFragment = (template: string, at: number | undefined) =>
    at === undefined
        ? undefined
        : interpolateRaw(template.replace(/^\{0\} · /, ''), '', formatWhen(at))

const diskFragment = (kind: LabelInput['diskFinding']) => {
    const { state } = i18n.value
    if (kind === 'missing') return fragment(state.fileMissing)
    if (kind === 'changed') return fragment(state.changedOnDisk)
    if (kind === 'newer') return fragment(state.newerOnDisk)
}

export const labelOf = ({
    name,
    file,
    changed,
    copyOf,
    diskFinding,
    showEvent,
}: LabelInput): StatusLabel => {
    if (file) {
        // The file Save writes to is always on screen: the bare name when it is the stem.
        const stem = inlineName(stemOf(file.name)) === inlineName(name)
        const { file: strings } = i18n.value
        // A download browser adds the state: Save there downloads a new copy, it writes no file.
        const event = !showEvent
            ? undefined
            : file.event === 'opened'
              ? eventFragment(strings.opened, file.at)
              : eventFragment(strings.downloaded, file.at)
        const state = [event, diskFragment(diskFinding)].filter(Boolean).join(' · ')
        return {
            name: stem ? '' : inlineName(name),
            file: inlineName(file.name),
            ...(state ? { state } : {}),
            changed,
        }
    }
    if (copyOf)
        return {
            name: inlineName(name),
            // An untitled source is the copy's own date name already; the label says only "copy".
            state: copyOf.name
                ? interpolateRaw(fragment(i18n.value.status.separateCopy), inlineName(copyOf.name))
                : fragment(i18n.value.status.separateCopyShort),
            changed: false,
        }
    return { name: inlineName(name), state: fragment(i18n.value.status.notInFile), changed: false }
}

/** The label as one line, joined with " · ", with the "•" when the file has changes. */
export const labelLine = ({ name, file, state, changed }: StatusLabel) => {
    const line = [name, file, state].filter(Boolean).join(' · ')
    return changed ? `${line} •` : line
}

/** The label's accessible name: "Coconut (Master), changed since coconut.nxsp was saved". */
export const labelAccessibleName = (
    label: StatusLabel,
    shown: string,
    file: LabelFile | undefined,
) => {
    if (!file || !label.changed) return labelLine(label)
    const { status } = i18n.value
    const template =
        file.event === 'saved'
            ? status.changedSaved
            : file.event === 'opened'
              ? status.changedOpened
              : status.changedDownload
    return interpolateRaw(template, inlineName(shown), inlineName(file.name))
}
