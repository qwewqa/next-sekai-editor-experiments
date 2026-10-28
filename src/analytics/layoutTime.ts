import type { WorkspaceLayout } from '../editor/workspace/layout'
import { SECONDS_CAP, type EventData } from './catalogue'
import { takeSeconds } from './intervals'
import { measured } from './scales'

// The `layout` event's accounting (docs/analytics.md): the time each panel, size and condition of
// the workspace layout was shown, as milliseconds per counter. The counters carry the event's own
// property names. Time is credited when the layout changes or at a send; nothing runs between.

/** The counters that the layout adds time to, named as the event's properties. */
export const layoutKeys = (
    layout: WorkspaceLayout,
    workspace: { width: number; height: number },
): string[] => {
    const keys: string[] = []
    const area = workspace.width * workspace.height
    let drawer = false
    let collapsed = false
    let suppressed = false
    let paired = false
    for (const dock of Object.values(layout.docks)) {
        for (const id of dock.visible) keys.push(`panelSeconds.${id}.${dock.side}`)
        for (const id of dock.covered) keys.push(`panelSeconds.${id}.covered`)
        if (dock.visible.length) {
            const size = measured('dockSize', dock.size)
            if (size) keys.push(`dockSizeSeconds.${dock.side}.${size}`)
            drawer ||= dock.overlay
        }
        // Preview's tile spans the dock's thickness, whichever side the dock is on.
        const preview = dock.visible.includes('preview')
            ? dock.tiles.find((tile) => tile.id === 'preview')
            : undefined
        const share = preview && measured('previewShare', (100 * dock.size * preview.size) / area)
        if (share) keys.push(`previewShareSeconds.${share}`)
        collapsed ||= dock.collapsed && !dock.suppressed
        suppressed ||= dock.suppressed
        paired ||= !!dock.sideBySide
    }
    if (drawer) keys.push('drawerSeconds')
    if (collapsed) keys.push('collapsedSeconds')
    if (suppressed) keys.push('suppressedSeconds')
    if (paired) keys.push('pairedSeconds')
    return keys
}

/**
 * Time per counter while the page is visible. `change` closes the time of the layout shown so far
 * and opens the next. `take` gives the whole seconds since the last call, and carries the rest.
 */
export const createLayoutTime = (now: () => number, visible: boolean, first: readonly string[]) => {
    let keys = first
    let since = visible ? now() : undefined
    const pending = new Map<string, number>()

    const credit = () => {
        const at = now()
        if (since !== undefined && at > since) {
            const elapsed = at - since
            pending.set('visibleTime', (pending.get('visibleTime') ?? 0) + elapsed)
            for (const key of keys) pending.set(key, (pending.get(key) ?? 0) + elapsed)
        }
        if (since !== undefined) since = at
    }

    return {
        change: (next: readonly string[]) => {
            if (next.length === keys.length && next.every((key, i) => key === keys[i])) return
            credit()
            keys = next
        },
        /** The page was shown or hidden. */
        visibility: (shown: boolean) => {
            credit()
            since = shown ? (since ?? now()) : undefined
        },
        /** The event for the time since the last call; nothing while that time rounds to no seconds. */
        take: (): EventData<'layout'> | undefined => {
            credit()
            const visible = takeSeconds(pending.get('visibleTime') ?? 0, 0).seconds
            if (!visible) return
            const data: Record<string, number> = {}
            for (const [key, ms] of pending) {
                const taken = takeSeconds(ms, 0)
                if (taken.seconds) data[key] = taken.seconds
                pending.set(key, ms - taken.sent)
            }
            // A capped interval is dropped whole: its left-over would skew the next one.
            if (visible >= SECONDS_CAP) pending.clear()
            return data
        },
    }
}
