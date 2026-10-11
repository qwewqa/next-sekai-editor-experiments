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

/** A pane y on the slot lattice through `anchor`, nearest `y`: where badges re-anchor without moving. */
export const offscreenSlotNear = (anchor: number, y: number) =>
    anchor + SLOT * Math.round((y - anchor) / SLOT)

/**
 * Badges sit in slots fixed to the content at `anchor` (a pane y), so they scroll with their notes.
 * Slots within a slot of an edge share one badge held there; notes only ever move to it with the scroll.
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
    // No room for a slot between the two held badges: one fixed to the pane, which scrolling can't empty.
    const short = last - first < 3 * SLOT
    // Slot centres past these are held at the top and bottom.
    const holdTop = first + SLOT / 2 + SLOT
    const holdBottom = last - SLOT / 2 - SLOT
    // A note counts until its slot leaves the pane, at whole slots from the holds: as one slot leaves, another is held.
    const exitTop = holdTop - SLOT * Math.ceil((holdTop - top + SLOT / 2) / SLOT)
    const exitBottom = holdBottom + SLOT * Math.ceil((bottom + SLOT / 2 - holdBottom) / SLOT)
    const groups = new Map<string, OffscreenNoteGroup<T>>()
    for (const note of notes) {
        if (!Number.isFinite(note.left) || !Number.isFinite(note.right) || !Number.isFinite(note.y))
            continue
        const side = note.right < 0 ? 'left' : note.left > width ? 'right' : undefined
        if (!side) continue
        let slot = Math.floor(note.y / SLOT)
        let y = (slot + 0.5) * SLOT
        let fixed = short
        if (short) {
            if (anchor + note.y < top || anchor + note.y > bottom) continue
            slot = 0
            y = (first + last) / 2
        } else {
            const center = anchor + y
            if (center < exitTop || center > exitBottom) continue
            if (center < holdTop) {
                slot = -Infinity
                y = first + SLOT / 2
                fixed = true
            } else if (center > holdBottom) {
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

// The badge nearest a pane point in its side's hit areas (slot bands, out from the edge), if it has selectable
// notes. Held badges' areas reach in to the first slot not held, so adjacent badges' areas meet.
export const hitOffscreenGroup = <T>(
    groups: readonly OffscreenNoteGroup<T>[],
    x: number,
    y: number,
    width: number,
    anchor = 0,
) => {
    let hit: OffscreenNoteGroup<T> | undefined
    let distance = Infinity
    let inside = false
    for (const group of groups) {
        const reach = offscreenBadgeHitWidth(group.count)
        if (group.side === 'left' ? x < 0 || x > reach : x > width || x < width - reach) continue
        const offset = y - (group.fixed ? group.y : anchor + group.y)
        const above =
            group.slot === Infinity
                ? group.y - (anchor + SLOT * Math.floor((group.y - SLOT / 2 - anchor) / SLOT))
                : group.spacing / 2
        const below =
            group.slot === -Infinity
                ? anchor + SLOT * Math.ceil((group.y + SLOT / 2 - anchor) / SLOT) - group.y
                : group.spacing / 2
        if (offset >= -above && offset <= below) inside = true
        if (Math.abs(offset) < distance) {
            hit = group
            distance = Math.abs(offset)
        }
    }
    // A dimmed badge still takes its own area.
    return inside && hit?.targets.length ? hit : undefined
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
