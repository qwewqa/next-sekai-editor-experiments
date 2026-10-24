import { computed } from 'vue'
import { session } from '../history/session'
import { liveState } from '../history/stack'
import { displayName, namePartsOf } from '../local/names'
import {
    diskFinding,
    downloadNotConfirmed,
    fileChanged,
    fileEvent,
    writesInPlace,
} from './file/state'
import { labelAccessibleName, labelLine, labelOf, type StatusLabel } from './fileLabel'
import { shownName } from './shownName'

// The status bar's label and the page title: the displayed name, then the file
// the session is bound to or the reason it is not, and a "•" when the file has changes. The
// parts are `labelOf`'s (`fileLabel.ts`), which Recent Sessions' rows call too.

export type { StatusLabel }

/** The displayed name of the open session. */
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

/** The open session's bound file as the label shows it. */
const liveFile = computed(() =>
    session.value.file ? { ...session.value.file, event: fileEvent.value } : undefined,
)

const liveInput = () => ({
    name: displayedName.value,
    changed: fileChanged.value,
    writesInPlace: writesInPlace(),
    ...(liveFile.value ? { file: liveFile.value } : {}),
    ...(session.value.copyOf ? { copyOf: session.value.copyOf } : {}),
    ...(diskFinding.value ? { diskFinding: diskFinding.value } : {}),
})

export const statusLabel = computed((): StatusLabel => labelOf(liveInput()))

/**
 * This tab's row of Recent Sessions: the status bar's label (one `labelOf`), which a row also
 * gives the download-not-confirmed fragment, as the chip does in the bar. Reached through
 * `liveRow.ts`, since History files may not import this module.
 */
export const liveRow = computed(() => {
    const label = labelOf({ ...liveInput(), notConfirmed: downloadNotConfirmed.value })
    return {
        name: displayedName.value,
        label,
        accessible: labelAccessibleName(label, displayedName.value, liveFile.value),
    }
})

/** The label as one line, joined with " · ", with the "•" when the file has changes. */
export const statusText = computed(() => labelLine(statusLabel.value))

/** The label's accessible name: "Coconut (Master), changed since coconut.nxsp was saved". */
export const statusName = computed(() => {
    return labelAccessibleName(statusLabel.value, displayedName.value, liveFile.value)
})
