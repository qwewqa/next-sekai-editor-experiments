import { computed } from 'vue'
import { session } from '../history/session'
import { liveState } from '../history/stack'
import { displayName, namePartsOf } from '../local/names'
import { diskFinding, fileChanged, fileEvent, writesInPlace } from './file/state'
import { labelAccessibleName, labelLine, labelOf, type StatusLabel } from './fileLabel'
import { shownName } from './shownName'

// The status bar's label and the page title (Part 1 §1.3.4): the displayed name, then the file
// the session is bound to or the reason it is not, and a "•" when the file has changes. The
// parts are `labelOf`'s (`fileLabel.ts`), which Recent Sessions' rows call too.

export type { StatusLabel }

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

export const statusLabel = computed((): StatusLabel =>
    labelOf({
        name: displayedName.value,
        changed: fileChanged.value,
        writesInPlace: writesInPlace(),
        ...(session.value.file ? { file: { ...session.value.file, event: fileEvent.value } } : {}),
        ...(session.value.copyOf ? { copyOf: session.value.copyOf } : {}),
        ...(diskFinding.value ? { diskFinding: diskFinding.value } : {}),
    }),
)

/** The label as one line, joined with " · ", with the "•" when the file has changes. */
export const statusText = computed(() => labelLine(statusLabel.value))

/** The label's accessible name: "Coconut (Master), changed since coconut.nxsp was saved". */
export const statusName = computed(() => {
    const file = session.value.file
    return labelAccessibleName(
        statusLabel.value,
        displayedName.value,
        file && { ...file, event: fileEvent.value },
    )
})
