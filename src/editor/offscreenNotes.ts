export type OffscreenNotePosition<T = unknown> = {
    left: number
    right: number
    y: number
    highlighted: boolean
    opacity: number
    // Set when the note can be selected from its badge.
    target?: T
}

export type OffscreenNoteGroup<T = unknown> = {
    side: 'left' | 'right'
    slot: number
    // From the grouping's anchor.
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

/**
 * Badges sit in slots fixed to the content at `anchor` (a pane y), so they scroll with their notes.
 * Only whole slots between the insets hold badges; notes in the rest count in the nearest one.
 */
export const groupOffscreenNotes = <T>(
    notes: readonly OffscreenNotePosition<T>[],
    width: number,
    top: number,
    bottom: number,
    inset = 0,
    anchor = 0,
) => {
    const groups = new Map<string, OffscreenNoteGroup<T>>()
    const first = top + inset
    const last = bottom - inset
    if (!(width > 0) || last - first < 24) return []
    // Too short for two slots: one fixed to the pane, which scrolling can't empty.
    const fixed = last - first < 2 * SLOT
    const origin = fixed ? first : anchor
    const spacing = fixed ? last - first : SLOT
    const min = fixed ? 0 : Math.ceil((first - origin) / spacing)
    const max = fixed ? 0 : Math.floor((last - origin) / spacing) - 1
    for (const note of notes) {
        if (
            !Number.isFinite(note.left) ||
            !Number.isFinite(note.right) ||
            !Number.isFinite(note.y) ||
            note.y < top ||
            note.y > bottom
        )
            continue
        const side = note.right < 0 ? 'left' : note.left > width ? 'right' : undefined
        if (!side) continue
        const slot = Math.min(max, Math.max(min, Math.floor((note.y - origin) / spacing)))
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
                y: origin - anchor + (slot + 0.5) * spacing,
                spacing,
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

// Selectable badge whose hit area (slot band, out from the edge) holds a point, y from the anchor.
export const hitOffscreenGroup = <T>(
    groups: readonly OffscreenNoteGroup<T>[],
    x: number,
    y: number,
    width: number,
) =>
    groups.find((group) => {
        if (!group.targets.length || Math.abs(y - group.y) > group.spacing / 2) return false
        const reach = offscreenBadgeHitWidth(group.count)
        return group.side === 'left' ? x >= 0 && x <= reach : x <= width && x >= width - reach
    })

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
