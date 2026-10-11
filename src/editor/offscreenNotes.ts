export type OffscreenNotePosition<T = unknown> = {
    left: number
    right: number
    // From the grouping's anchor, so slots don't depend on the scroll position.
    y: number
    highlighted: boolean
    opacity: number
    // Set when the note can be selected from its badge.
    target?: T
}

export type OffscreenNoteGroup<T = unknown> = {
    side: 'left' | 'right'
    // -Infinity and Infinity for the badges held at the top and bottom edges.
    slot: number
    // Held at the band's edge: y is a pane y, not one from the anchor.
    fixed: boolean
    y: number
    spacing: number
    count: number
    highlighted: boolean
    opacity: number
    targets: T[]
}

// One line of the chart's corner range labels.
export const RANGE_LABEL_HEIGHT = 24

const SLOT = 28
// Badge height; badges closer than this would overlap.
const BADGE = 24

/**
 * Badges sit in slots fixed to the content at `anchor` (a pane y), so they scroll with their notes.
 * Slots within a badge of an edge share one badge held there; notes only ever move to it with the scroll.
 */
export const groupOffscreenNotes = <T>(
    notes: readonly OffscreenNotePosition<T>[],
    width: number,
    top: number,
    bottom: number,
    inset = 0,
    anchor = 0,
) => {
    const first = top + inset
    const last = bottom - inset
    if (!(width > 0) || last - first < BADGE) return []
    // Too short for two slots: one fixed to the pane, which scrolling can't empty.
    const short = last - first < 2 * SLOT
    const groups = new Map<string, OffscreenNoteGroup<T>>()
    for (const note of notes) {
        if (
            !Number.isFinite(note.left) ||
            !Number.isFinite(note.right) ||
            !Number.isFinite(note.y) ||
            anchor + note.y < top ||
            anchor + note.y > bottom
        )
            continue
        const side = note.right < 0 ? 'left' : note.left > width ? 'right' : undefined
        if (!side) continue
        let slot = Math.floor(note.y / SLOT)
        let y = (slot + 0.5) * SLOT
        let fixed = short
        if (short) {
            slot = 0
            y = (first + last) / 2
        } else {
            // Held at the nearer edge whose badge it would overlap.
            const toTop = anchor + y - (first + SLOT / 2)
            const toBottom = last - SLOT / 2 - (anchor + y)
            if (toTop < BADGE && toTop <= toBottom) {
                slot = -Infinity
                y = first + SLOT / 2
                fixed = true
            } else if (toBottom < BADGE) {
                slot = Infinity
                y = last - SLOT / 2
                fixed = true
            }
        }
        const key = `${side}:${slot}`
        let group = groups.get(key)
        if (group) {
            group.count++
            group.highlighted ||= note.highlighted
            group.opacity = Math.max(group.opacity, note.opacity)
        } else {
            group = {
                side,
                slot,
                fixed,
                y,
                spacing: short ? last - first : SLOT,
                count: 1,
                highlighted: note.highlighted,
                opacity: note.opacity,
                targets: [],
            }
            groups.set(key, group)
        }
        if (note.target !== undefined) group.targets.push(note.target)
    }
    return [...groups.values()]
}

/** Whether two groupings show the same badges with the same targets. */
export const isSameOffscreenGroups = <T>(
    a: readonly OffscreenNoteGroup<T>[],
    b: readonly OffscreenNoteGroup<T>[],
) =>
    a.length === b.length &&
    a.every((group, index) => {
        const other = b[index]
        return (
            group.side === other?.side &&
            group.slot === other.slot &&
            group.fixed === other.fixed &&
            group.y === other.y &&
            group.spacing === other.spacing &&
            group.count === other.count &&
            group.highlighted === other.highlighted &&
            group.opacity === other.opacity &&
            group.targets.length === other.targets.length &&
            group.targets.every((target, i) => target === other.targets[i])
        )
    })

// Badge width estimate (inset, chevron, digits) with slack; at least a touch target.
export const offscreenBadgeHitWidth = (count: number) => Math.max(44, 40 + 7 * String(count).length)

// Selectable badge whose hit area (slot band, out from the edge) holds a pane point; the nearest where bands meet.
export const hitOffscreenGroup = <T>(
    groups: readonly OffscreenNoteGroup<T>[],
    x: number,
    y: number,
    width: number,
    anchor = 0,
) => {
    let hit: OffscreenNoteGroup<T> | undefined
    let distance = Infinity
    for (const group of groups) {
        const offset = Math.abs(y - (group.fixed ? group.y : anchor + group.y))
        if (!group.targets.length || offset > group.spacing / 2 || offset >= distance) continue
        const reach = offscreenBadgeHitWidth(group.count)
        if (group.side === 'left' ? x >= 0 && x <= reach : x <= width && x >= width - reach) {
            hit = group
            distance = offset
        }
    }
    return hit
}

// Ctrl removes the targets when all are selected and adds them otherwise.
export const combineSelection = <T>(
    selected: readonly T[],
    targets: readonly T[],
    ctrl: boolean,
) => {
    if (!ctrl) return [...targets]
    const current = new Set(selected)
    if (targets.every((target) => current.has(target))) {
        const removed = new Set(targets)
        return selected.filter((entity) => !removed.has(entity))
    }
    return [...new Set([...selected, ...targets])]
}
