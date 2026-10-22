import { computed, shallowRef, watch, type Ref } from 'vue'
import type { EntryKey } from '../../history/peek'
import type { State } from '../../state'
import { comparePropertyChanges, type PropertyChanges } from './propertyChanges'
import type { ChainKey, PeekedInfo } from './selection'

/** Raw chronological endpoints resolved by the current comparison, never the displayed peek. */
export type InspectionComparison = {
    request: PeekedInfo
    previous: ChainKey
    state: State
    set: { header: boolean }
}

export type PropertyInspection = {
    comparison: InspectionComparison
    status: 'loading' | 'known' | 'unavailable'
    delayed: boolean
    changes?: PropertyChanges
}

/** One lazy inspection; selection, close and reset invalidate it without cancelling shared loads. */
export const createPropertyInspection = (
    current: Readonly<Ref<InspectionComparison | undefined>>,
    load: (key: EntryKey) => Promise<State>,
) => {
    const value = shallowRef<PropertyInspection>()
    let generation = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const close = () => {
        generation++
        clearTimeout(timer)
        timer = undefined
        value.value = undefined
    }
    const unwatch = watch(
        current,
        (comparison) => {
            if (value.value && value.value.comparison !== comparison) close()
        },
        { flush: 'sync' },
    )
    const open = () => {
        const comparison = current.value
        close()
        if (!comparison?.set.header) return
        const at = generation
        const previous = comparison.previous
        const key = previous.key
        const snapshot = previous.snapshot
        const request = comparison.request
        const after = comparison.state
        value.value = { comparison, status: 'loading', delayed: false }
        const active = () =>
            at === generation &&
            current.value === comparison &&
            comparison.request === request &&
            comparison.previous === previous &&
            previous.key === key &&
            previous.snapshot === snapshot &&
            comparison.state === after
        timer = setTimeout(() => {
            if (active() && value.value?.status === 'loading')
                value.value = { comparison, status: 'loading', delayed: true }
        }, 250)
        void Promise.resolve()
            .then(() => (active() ? load(key) : undefined))
            .then(
                (before) => {
                    if (!active() || !before) return
                    try {
                        const changes = comparePropertyChanges(before, after, {
                            expectedDifference: true,
                        })
                        value.value = { comparison, status: 'known', delayed: false, changes }
                    } catch {
                        value.value = { comparison, status: 'unavailable', delayed: false }
                    }
                    clearTimeout(timer)
                    timer = undefined
                },
                () => {
                    if (!active()) return
                    value.value = { comparison, status: 'unavailable', delayed: false }
                    clearTimeout(timer)
                    timer = undefined
                },
            )
    }
    return {
        inspection: computed(() => value.value),
        available: computed(() => !!current.value?.set.header),
        open,
        close,
        dispose: () => {
            close()
            unwatch()
        },
    }
}

/**
 * A local choice for a continuous peek, kept for the session: the next peek starts as the last one
 * was left, until the setting that gives the default changes. The setting is read only on entry.
 */
export const createShowEdits = (peeking: Readonly<Ref<boolean>>, defaultValue: () => boolean) => {
    const value = shallowRef(false)
    let chosen: boolean | undefined
    const unwatch = watch(
        peeking,
        (active, previous) => {
            if (!active) value.value = false
            else if (!previous) value.value = chosen ?? defaultValue()
        },
        { immediate: true, flush: 'sync' },
    )
    const unwatchDefault = watch(
        defaultValue,
        () => {
            chosen = undefined
        },
        { flush: 'sync' },
    )
    const set = (show: boolean) => {
        if (!peeking.value) return
        value.value = show
        chosen = show
    }
    return {
        showEdits: computed(() => value.value),
        set,
        toggle: () => {
            set(!value.value)
        },
        reset: () => {
            value.value = false
        },
        dispose: () => {
            unwatch()
            unwatchDefault()
        },
    }
}

/** Paint gating never changes the raw marks used by navigation and composed geometry. */
export const createChangePaint = <Entity, Marks extends { changed: ReadonlySet<Entity> }>(
    raw: Readonly<Ref<Marks | undefined>>,
    peeking: Readonly<Ref<boolean>>,
    showEdits: Readonly<Ref<boolean>>,
    status: Readonly<Ref<'loading' | 'known' | 'initial' | 'unavailable'>>,
    hasObjectChange: Readonly<Ref<boolean>>,
) => {
    const held = shallowRef(false)
    const nothing: ReadonlySet<Entity> = new Set()
    const marks = computed(() => (peeking.value && showEdits.value ? raw.value : undefined))
    const unwatch = watch(
        [marks, status, peeking, showEdits, hasObjectChange],
        () => {
            if (!peeking.value || !showEdits.value) held.value = false
            else if (marks.value) held.value = true
            else if (
                status.value === 'initial' ||
                status.value === 'unavailable' ||
                !hasObjectChange.value
            )
                held.value = false
        },
        { immediate: true, flush: 'sync' },
    )
    const undimmed = computed(() => {
        if (!peeking.value || !showEdits.value) return
        if (marks.value) return marks.value.changed
        const loading =
            status.value === 'loading' || (status.value === 'known' && hasObjectChange.value)
        return loading && held.value ? nothing : undefined
    })
    return { marks, undimmed, dispose: unwatch }
}
