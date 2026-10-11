import { computed, reactive, ref } from 'vue'
import { settings } from '../settings'
import { hasToolModal } from './toolModals'
import { view } from './view'

type Size = { width: number; height: number }
type Row = { time: Size; beat: Size }

/** A label's box in pane pixels. */
export type LabelBox = { left: number; right: number; top: number; bottom: number }

const row = (): Row => ({ time: { width: 0, height: 0 }, beat: { width: 0, height: 0 } })

/** The laid-out sizes of the time and beat labels over the chart's edges and at the hover time. */
export const edgeLabelSizes = reactive({ top: row(), bottom: row(), hover: row() })

/** Where the hover time's labels are centred, in pane pixels. */
export const hoverLabelCenter = computed(
    () => 0.5 * view.h - (view.hoverTime - view.time) * settings.pps,
)

/** How far the hover labels' figures sit below their box's centre, which is moved up by as much. */
export const hoverFigureOffset = ref(0)

// A docked dialog (up to 28rem wide, centered at the bottom) covers the lower
// labels in narrow panes; hidden there rather than left peeking out under its
// rounded corners.
export const lowerEdgeLabelsCovered = computed(() => hasToolModal('main') && view.w < 640)

/** The labels' inset from the pane's sides, which lines across the chart also keep from them. */
const edgeLabelInset = ref(4)

const sizes = new WeakMap<Element, Size>()
let observer: ResizeObserver | undefined

/** Keeps `size` at the element's border box size. */
export const observeLabelSize = (element: Element, size: Size) => {
    observer ??= new ResizeObserver((entries) => {
        for (const entry of entries) {
            const target = sizes.get(entry.target)
            const box = entry.borderBoxSize[0]
            const content = entry.contentBoxSize[0]
            if (!target || !box || !content) continue
            target.width = box.inlineSize
            target.height = box.blockSize
            // Only the outer side is padded.
            edgeLabelInset.value = box.inlineSize - content.inlineSize
        }
    })
    sizes.set(element, size)
    observer.observe(element)
}

export const unobserveLabelSize = (element: Element) => {
    sizes.delete(element)
    observer?.unobserve(element)
}

type RowBoxes = { time: LabelBox; beat: LabelBox }

const rowBoxes = ({ time, beat }: Row, top: number): RowBoxes => ({
    time: { left: 0, right: time.width, top, bottom: top + time.height },
    beat: { left: view.w - beat.width, right: view.w, top, bottom: top + beat.height },
})

const height = ({ time, beat }: Row) => Math.max(time.height, beat.height)

const rows = computed(() => {
    const { top, bottom, hover } = edgeLabelSizes
    return {
        top: rowBoxes(top, 0),
        bottom: rowBoxes(bottom, view.h - height(bottom)),
        hover: rowBoxes(
            hover,
            hoverLabelCenter.value - hoverFigureOffset.value - height(hover) / 2,
        ),
    }
})

const overlaps = (a: LabelBox, b: LabelBox) =>
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

/** The edge labels under the hover time and beat labels, hidden while they are. */
export const coveredEdgeLabels = computed(() => {
    const { top, bottom, hover } = rows.value
    const covered = (box: LabelBox) =>
        !view.isHoverHidden && (overlaps(box, hover.time) || overlaps(box, hover.beat))
    return {
        top: { time: covered(top.time), beat: covered(top.beat) },
        bottom: { time: covered(bottom.time), beat: covered(bottom.beat) },
    }
})

/** Where the time (left) and beat (right) labels over the chart lie, in pane pixels. */
export const edgeLabelBoxes = computed(() => {
    const boxes: SideBoxes = { left: [], right: [] }
    const add = ({ time, beat }: RowBoxes, hidden = { time: false, beat: false }) => {
        if (!hidden.time) boxes.left.push(time)
        if (!hidden.beat) boxes.right.push(beat)
    }
    const { top, bottom, hover } = rows.value
    const covered = coveredEdgeLabels.value
    add(top, covered.top)
    if (!lowerEdgeLabelsCovered.value) add(bottom, covered.bottom)
    if (!view.isHoverHidden) add(hover)
    return boxes
})

/** A line's ends across the pane. */
export type LineSpan = { left: number; right: number }

/** Labels on either side of a line, by the side it stops at. */
export type SideBoxes = { left: LabelBox[]; right: LabelBox[] }

/**
 * Where a line across the pane at `y` stops, an inset short of the edge labels and
 * the `other` labels it meets, in pane pixels.
 */
export const lineSpanAt = (y: number, other?: SideBoxes): LineSpan => {
    const edges = edgeLabelBoxes.value
    const left = other ? [...edges.left, ...other.left] : edges.left
    const right = other ? [...edges.right, ...other.right] : edges.right
    const inset = edgeLabelInset.value
    // Lines are 2 pixels wide.
    const meets = (box: LabelBox) => box.top - 1 < y && y < box.bottom + 1
    return {
        left: Math.max(-Infinity, ...left.filter(meets).map((box) => box.right + inset)),
        right: Math.min(Infinity, ...right.filter(meets).map((box) => box.left - inset)),
    }
}
