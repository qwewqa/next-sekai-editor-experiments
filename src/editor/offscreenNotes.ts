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
    side: 'left' | 'right' | 'top' | 'bottom'
    // -Infinity and Infinity for the side badges held at the top and bottom edges; a row's cell.
    slot: number
    // Held at the band's edge: y is a pane y, not one from the anchor.
    fixed: boolean
    y: number
    // A top or bottom badge's pane x, and the pane xs its hit area spans.
    x?: number
    hitLeft?: number
    hitRight?: number
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
// Notes count until at most this far past an edge, where their slots leave.
export const OFFSCREEN_REACH = 2 * SLOT

/** A pane y on the slot lattice through `anchor`, nearest `y`: where badges re-anchor without moving. */
export const offscreenSlotNear = (anchor: number, y: number) =>
    anchor + SLOT * Math.round((y - anchor) / SLOT)

const offSide = (note: OffscreenNotePosition, width: number) =>
    note.right < 0 ? 'left' : note.left > width ? 'right' : undefined

// The side badges' band, where its slots are held and where their notes leave.
const sideBand = (top: number, bottom: number, inset: number) => {
    const first = top + inset
    const last = bottom - inset
    // Slot centres past these are held at the top and bottom.
    const holdTop = first + SLOT / 2 + SLOT
    const holdBottom = last - SLOT / 2 - SLOT
    return {
        first,
        last,
        // Less than half a badge of ride between holds reads as one double hop: one badge fixed instead.
        short: last - first < 3 * SLOT + BADGE / 2,
        holdTop,
        holdBottom,
        // Notes count until their slot leaves, whole slots past the holds: one goes as the next is held.
        exitTop: holdTop - SLOT * Math.ceil((holdTop - top + SLOT / 2) / SLOT),
        exitBottom: holdBottom + SLOT * Math.ceil((bottom + SLOT / 2 - holdBottom) / SLOT),
    }
}

// Where a side badge takes a note, if one does.
const placeOnSide = (width: number, top: number, bottom: number, inset: number, anchor: number) => {
    const { first, last, short, holdTop, holdBottom, exitTop, exitBottom } = sideBand(
        top,
        bottom,
        inset,
    )
    if (!(width > 0) || last - first < BADGE) return () => undefined
    return (note: OffscreenNotePosition) => {
        const side = offSide(note, width)
        if (!side) return
        let slot = Math.floor(note.y / SLOT)
        let y = (slot + 0.5) * SLOT
        let fixed = short
        if (short) {
            if (anchor + note.y < top || anchor + note.y > bottom) return
            slot = 0
            y = (first + last) / 2
        } else {
            const center = anchor + y
            if (center < exitTop || center > exitBottom) return
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
        return { side, slot, fixed, y, spacing: short ? last - first : SLOT } as const
    }
}

const isFinitePosition = (note: OffscreenNotePosition) =>
    Number.isFinite(note.left) && Number.isFinite(note.right) && Number.isFinite(note.y)

type Placement = Pick<
    OffscreenNoteGroup,
    'side' | 'slot' | 'fixed' | 'y' | 'x' | 'hitLeft' | 'hitRight' | 'spacing'
>

const addToGroup = <T>(
    groups: Map<string, OffscreenNoteGroup<T>>,
    note: OffscreenNotePosition<T>,
    placement: Placement,
) => {
    const key = `${placement.side}:${placement.slot}`
    let group = groups.get(key)
    if (group) {
        group.count++
        group.highlighted ||= note.highlighted
        group.opacity = Math.max(group.opacity, note.opacity)
    } else {
        group = {
            ...placement,
            count: 1,
            highlighted: note.highlighted,
            opacity: note.opacity,
            targets: [],
        }
        groups.set(key, group)
    }
    if (note.target !== undefined) group.targets.push(note.target)
}

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
    const place = placeOnSide(width, top, bottom, inset, anchor)
    const groups = new Map<string, OffscreenNoteGroup<T>>()
    for (const note of notes) {
        const placement = isFinitePosition(note) ? place(note) : undefined
        if (placement) addToGroup(groups, note, placement)
    }
    return [...groups.values()]
}

type OffscreenSlot<T> = {
    // Its badge between the holds.
    group: OffscreenNoteGroup<T>
    // Its targets with their note indices, which order a held badge's targets.
    ranked: [number, T][]
}

/** Notes off a side by slot. Scrolling leaves them unchanged; `placeOffscreenSlots` places them. */
export type OffscreenSlots<T = unknown> = {
    notes: readonly OffscreenNotePosition<T>[]
    width: number
    // By slot and side: 2 × slot, plus 1 on the right.
    slots: Map<number, OffscreenSlot<T>>
}

/** Slots `groupOffscreenNotes`'s notes; a slot whose badge `previous` shows the same keeps it. */
export const slotOffscreenNotes = <T>(
    notes: readonly OffscreenNotePosition<T>[],
    width: number,
    previous?: OffscreenSlots<T>,
): OffscreenSlots<T> => {
    const slots = new Map<number, OffscreenSlot<T>>()
    notes.forEach((note, rank) => {
        const side = isFinitePosition(note) ? offSide(note, width) : undefined
        if (!side) return
        const slot = Math.floor(note.y / SLOT)
        const key = 2 * slot + +(side === 'right')
        let entry = slots.get(key)
        if (!entry) {
            entry = {
                group: {
                    side,
                    slot,
                    fixed: false,
                    y: (slot + 0.5) * SLOT,
                    spacing: SLOT,
                    count: 0,
                    highlighted: false,
                    opacity: note.opacity,
                    targets: [],
                },
                ranked: [],
            }
            // Slots keep their first notes' order.
            slots.set(key, entry)
        }
        const { group } = entry
        group.count++
        group.highlighted ||= note.highlighted
        group.opacity = Math.max(group.opacity, note.opacity)
        if (note.target === undefined) return
        group.targets.push(note.target)
        entry.ranked.push([rank, note.target])
    })
    // Unchanged badges keep their objects, so they don't re-render.
    for (const [key, entry] of slots) {
        const kept = previous?.slots.get(key)?.group
        if (kept && isSameOffscreenGroups([kept], [entry.group])) entry.group = kept
    }
    return { notes, width, slots }
}

/** `groupOffscreenNotes` for slotted notes, in a scroll's time: the same badges in the same order. */
export const placeOffscreenSlots = <T>(
    { notes, width, slots }: OffscreenSlots<T>,
    top: number,
    bottom: number,
    inset = 0,
    anchor = 0,
) => {
    const band = sideBand(top, bottom, inset)
    if (!(width > 0) || band.last - band.first < BADGE) return []
    // A short band takes notes by their own ys.
    if (band.short) return groupOffscreenNotes(notes, width, top, bottom, inset, anchor)
    const groups: OffscreenNoteGroup<T>[] = []
    const held = new Map<string, { group: OffscreenNoteGroup<T>; targets: [number, T][] }>()
    // Badges keep their first notes' order: a held one takes its first slot's place.
    for (const { group, ranked } of slots.values()) {
        const center = anchor + group.y
        if (center < band.exitTop || center > band.exitBottom) continue
        if (center >= band.holdTop && center <= band.holdBottom) {
            groups.push(group)
            continue
        }
        const slot = center < band.holdTop ? -Infinity : Infinity
        const key = `${group.side}:${slot}`
        let entry = held.get(key)
        if (!entry) {
            const y = slot < 0 ? band.first + SLOT / 2 : band.last - SLOT / 2
            entry = {
                group: {
                    ...group,
                    slot,
                    fixed: true,
                    y,
                    count: 0,
                    highlighted: false,
                    targets: [],
                },
                targets: [],
            }
            held.set(key, entry)
            groups.push(entry.group)
        }
        entry.group.count += group.count
        entry.group.highlighted ||= group.highlighted
        entry.group.opacity = Math.max(entry.group.opacity, group.opacity)
        for (const item of ranked) entry.targets.push(item)
    }
    for (const { group, targets } of held.values())
        group.targets = targets.sort((a, b) => a[0] - b[0]).map(([, target]) => target)
    return groups
}

// A top or bottom badge's cell width, and its hit area's height.
const CELL = 48
const ROW_REACH = 44

export type OffscreenEdges = {
    // Note centre pane ys past which notes are off the top and bottom.
    above: number
    below: number
    // Pane y the bottom row stays above, as of the toolbar.
    floor: number
    // Pane xs the cells stay between, clear of the side badges and axis labels.
    left: number
    right: number
    // Pane xs the end cells' hit areas reach, to meet the side badges'.
    reachLeft: number
    reachRight: number
    // Pane x of a cell's centre, so cells scroll with their notes.
    origin: number
    // Device pixels per pane pixel, which the badges land on.
    pixelRatio: number
}

const isEdgeGroup = (group: OffscreenNoteGroup) => group.side === 'top' || group.side === 'bottom'

/**
 * Top and bottom badges for the notes above and below that no side badge takes, given the side
 * grouping's arguments: each note is on one badge. Cells sit at their notes' x, held at the row ends.
 * A note off a side that no side badge takes goes to the row nearer it.
 */
export const groupOffscreenEdgeNotes = <T>(
    notes: readonly OffscreenNotePosition<T>[],
    width: number,
    top: number,
    bottom: number,
    inset: number,
    anchor: number,
    edges: OffscreenEdges,
) => {
    if (!(width > 0) || !(bottom > top)) return []
    const place = placeOnSide(width, top, bottom, inset, anchor)
    const ratio = edges.pixelRatio
    const pixel = (x: number) => Math.round(x * ratio) / ratio
    const rows = {
        top: pixel(top + inset + SLOT / 2),
        bottom: pixel(Math.min(bottom - inset, edges.floor) - SLOT / 2),
    }
    const middle = (top + bottom) / 2
    const firstCell = Math.ceil((edges.left - edges.origin) / CELL + 0.5)
    const lastCell = Math.floor((edges.right - edges.origin) / CELL - 0.5)
    // Too narrow for a cell: one badge in the middle.
    const single = lastCell < firstCell
    const groups = new Map<string, OffscreenNoteGroup<T>>()
    for (const note of notes) {
        if (!isFinitePosition(note) || place(note)) continue
        const y = anchor + note.y
        const side = offSide(note, width)
            ? y < middle
                ? 'top'
                : 'bottom'
            : y < edges.above
              ? 'top'
              : y > edges.below
                ? 'bottom'
                : undefined
        if (!side) continue
        const cell = Math.round(((note.left + note.right) / 2 - edges.origin) / CELL)
        const slot = single ? 0 : Math.min(Math.max(cell, firstCell), lastCell)
        const x = single ? pixel((edges.left + edges.right) / 2) : edges.origin + slot * CELL
        // The end cells' hit areas reach the row's ends.
        addToGroup(groups, note, {
            side,
            slot,
            fixed: true,
            y: rows[side],
            x,
            hitLeft: single || slot === firstCell ? edges.reachLeft : x - CELL / 2,
            hitRight: single || slot === lastCell ? edges.reachRight : x + CELL / 2,
            spacing: CELL,
        })
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
            group === other ||
            (group.side === other?.side &&
                group.slot === other.slot &&
                group.fixed === other.fixed &&
                group.y === other.y &&
                group.x === other.x &&
                group.hitLeft === other.hitLeft &&
                group.hitRight === other.hitRight &&
                group.spacing === other.spacing &&
                group.count === other.count &&
                group.highlighted === other.highlighted &&
                group.opacity === other.opacity &&
                group.targets.length === other.targets.length &&
                group.targets.every((target, i) => target === other.targets[i]))
        )
    })

// Badge width estimate (inset, chevron, digits) with slack; at least a touch target.
export const offscreenBadgeHitWidth = (count: number) => Math.max(44, 40 + 7 * String(count).length)

// The nearest badge whose hit area holds a point, if selectable; held areas reach the next slot.
export const hitOffscreenGroup = <T>(
    groups: readonly OffscreenNoteGroup<T>[],
    x: number,
    y: number,
    width: number,
    anchor = 0,
) => {
    // Top and bottom cells tile their rows, clear of the side badges.
    for (const group of groups) {
        if (
            isEdgeGroup(group) &&
            x >= (group.hitLeft ?? 0) &&
            x <= (group.hitRight ?? 0) &&
            Math.abs(y - group.y) <= ROW_REACH / 2
        )
            return group.targets.length ? group : undefined
    }
    let hit: OffscreenNoteGroup<T> | undefined
    let distance = Infinity
    let inside = false
    for (const group of groups) {
        if (isEdgeGroup(group)) continue
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
