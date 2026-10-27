import { computed, shallowRef, watch } from 'vue'
import { session, type SessionFile } from '../../history/session'
import { headSnapshot, isDirty, liveState, loadedHeadSnapshot } from '../../history/stack'
import { keptNameOf } from '../../local/names'
import { platform } from '../../platform'
import type { State } from '../../state'
import { chipStates, type ChipKind } from './chip'
import { sameFileContent } from './content'
import { notStored } from './notStored'

// The passive file state of the open session: what the status label, the chip,
// `document.title` and the close prompt read. The save flows (`src/editor/save`) set it.

/** What a check found on disk: `changed`, `newer` (it descends from the binding) or `missing`. */
export type DiskFinding = {
    sessionId: string
    kind: 'changed' | 'newer' | 'missing'
}

// `derived`: found from the head's stored root, not held at the event. It follows the stack while
// the root is the binding's hash, and a state held at a Save or an open is never replaced.
const eventState = shallowRef<{ sessionId: string; state: State; derived?: true }>()
const finding = shallowRef<DiskFinding>()

/**
 * Binds the open session to a file at a file event (Save, an open): the label reads it, and
 * `state` is what the file holds, for "changed since". Leaves the check's finding behind: a Save
 * or an open ends it.
 */
export const bindFile = (file: SessionFile, state?: State) => {
    const current = session.value
    session.value = { ...current, file }
    eventState.value = state && { sessionId: current.sessionId, state }
    finding.value = undefined
}

/** Binds nothing: the session lost its file, whose stem stays its name. */
export const unbindFile = () => {
    const { file, ...rest } = session.value
    const name = keptNameOf(rest.name, file?.name)
    session.value = name === undefined ? rest : { ...rest, name }
    eventState.value = undefined
    finding.value = undefined
}

/** Sets what a check found on disk for the open session, or clears it. */
export const setDiskFinding = (kind: DiskFinding['kind'] | undefined) => {
    finding.value = kind && { sessionId: session.value.sessionId, kind }
}

export const boundFile = computed(() => session.value.file)

/** The file event: 'saved', 'downloaded' or 'opened'; an unknown value reads as a download. */
export const fileEvent = computed(() => {
    const event = boundFile.value?.event
    return event === 'saved' || event === 'opened' ? event : 'downloaded'
})

const hexOf = (bytes: Uint8Array) =>
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

// A session opened bound (a reload, a new visit, an open) has no state of the event in memory: the
// head slot whose stored root is the binding's hash is that state, so later content is compared
// with it. Only a loaded head counts: at the moments of a stack swap or a queued move, when
// `liveState` still shows the previous head, a root read beside it would record the wrong state.
watch(
    [() => session.value, loadedHeadSnapshot, liveState],
    () => {
        const file = session.value.file
        const root = loadedHeadSnapshot.value
        const held = eventState.value
        if (!file?.hash || !root || (held?.sessionId === session.value.sessionId && !held.derived))
            return
        if (hexOf(root) === file.hash)
            eventState.value = {
                sessionId: session.value.sessionId,
                state: liveState.value,
                derived: true,
            }
    },
    { flush: 'sync', immediate: true },
)

/**
 * Changed since the file event. The state held at the event first; after a reload the head's
 * stored root against the binding's hash; otherwise a state with no root yet counts as changed.
 */
export const fileChanged = computed(() => {
    const file = boundFile.value
    if (!file) return false
    const held = eventState.value
    if (held?.sessionId === session.value.sessionId)
        return !sameFileContent(liveState.value, held.state)
    const root = headSnapshot.value
    if (root && file.hash !== undefined) return hexOf(root) !== file.hash
    return true
})

/**
 * Whether the open session has work no file holds: changed since the file event when bound,
 * otherwise any edit. A download counts as the file here.
 */
export const workNotInFile = computed(() => (boundFile.value ? fileChanged.value : isDirty.value))

/** Whether Save writes the bound file in place (Chromium) rather than downloading a copy. */
export const writesInPlace = () => platform.capabilities.writeBack

const found = computed(() =>
    finding.value?.sessionId === session.value.sessionId ? finding.value.kind : undefined,
)

/** The states other modules raise. */
export const raised = {
    notStored: shallowRef(false),
}

// Not stored follows the storage status once its cause has held for a moment (`notStored.ts`).
watch(
    notStored,
    (cause) => {
        raised.notStored.value = cause !== undefined
    },
    {
        flush: 'sync',
        immediate: true,
    },
)

/** Every state raised for the open session, highest priority first. */
export const chipKinds = computed(() => {
    const kinds: ChipKind[] = []
    if (raised.notStored.value) kinds.push('notStored')
    if (boundFile.value) {
        if (found.value === 'missing') kinds.push('fileMissing')
        if (found.value === 'changed') kinds.push('changedOnDisk')
        if (found.value === 'newer') kinds.push('newerOnDisk')
    }
    return chipStates(kinds)
})

/** The chip's state, and the lower-priority ones its dialog lists as lines. */
export const chip = computed(() => {
    const [kind, ...rest] = chipKinds.value
    return kind && { kind, rest }
})

/** What a check found, for the label's fragment and the chip's dialog. */
export const diskFinding = found
