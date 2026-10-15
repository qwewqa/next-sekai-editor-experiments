/** The fitted name's scene-space box; clipping at the pane edge can change it. */
export type NameBox = { l: number; r: number; t: number; b: number }

export type NamePlacement = {
    owner: object
    /** Original role and text, before fitting it at the pane edge. */
    key: string
    highlighted: boolean
    box: NameBox
}

const overlaps = (a: NameBox, b: NameBox) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b

// Names normally have a 0.4-unit em. Two-dimensional bins keep dense selected
// clusters from making unrelated names search every highlighted label.
const binWidth = 2
const binHeight = 0.5

class OccupiedNames {
    private columns = new Map<number, Map<number, NameBox[]>>()

    overlaps(box: NameBox) {
        for (let x = Math.floor(box.l / binWidth); x <= Math.floor(box.r / binWidth); x++) {
            const column = this.columns.get(x)
            if (!column) continue
            for (let y = Math.floor(box.t / binHeight); y <= Math.floor(box.b / binHeight); y++) {
                const row = column.get(y)
                if (row) for (const other of row) if (overlaps(box, other)) return true
            }
        }
        return false
    }

    add(box: NameBox) {
        for (let x = Math.floor(box.l / binWidth); x <= Math.floor(box.r / binWidth); x++) {
            let column = this.columns.get(x)
            if (!column) this.columns.set(x, (column = new Map<number, NameBox[]>()))
            for (let y = Math.floor(box.t / binHeight); y <= Math.floor(box.b / binHeight); y++) {
                const row = column.get(y)
                if (row) row.push(box)
                else column.set(y, [box])
            }
        }
    }
}

/** Retains only the last frame's visible identities, owned by one editor context. */
export class NameLayout {
    private previous = new Map<object, Set<string>>()

    place(names: readonly NamePlacement[]) {
        const occupied = new OccupiedNames()
        const visible = new Set<NamePlacement>()
        const next = new Map<object, Set<string>>()
        const admit = (name: NamePlacement) => {
            visible.add(name)
            occupied.add(name.box)
            let keys = next.get(name.owner)
            if (!keys) next.set(name.owner, (keys = new Set()))
            keys.add(name.key)
        }
        // Reserve selected/hovered names before ordinary names, even when the
        // highlighted names overlap each other. Their painter order stays intact.
        for (const name of names) if (name.highlighted) admit(name)
        // Keep accepted labels in place while scrolling. New labels entering at
        // a viewport edge must not reshuffle the rest of a dense column.
        for (const name of names) {
            if (name.highlighted || !this.previous.get(name.owner)?.has(name.key)) continue
            if (!occupied.overlaps(name.box)) admit(name)
        }
        for (const name of names) {
            if (!visible.has(name) && !occupied.overlaps(name.box)) admit(name)
        }
        this.previous = next
        return visible
    }
}
