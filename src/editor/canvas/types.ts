import type { GroupId } from '../../chart/groups'
import type { WebGLDrawContext } from '../../rendering/context'
import type { State } from '../../state'
import type { StoreSlides } from '../../state/store/slides'
import type { createComposedLayout } from '../composed'
import type { LabelSprites } from './labelSprites'
import type { NameLayer } from './names'

export type CanvasBounds = {
    l: number
    r: number
    t: number
    b: number
    w: number
    h: number
}

/** Where time scale labels reach the time column (left) and beat column (right). */
export type EdgeLabelYs = { left: number[]; right: number[] }

/** Browser font metrics are independent of the surface used to draw the scene. */
export type EditorMeasureContext = Omit<EditorDrawContext, 'ctx'> & {
    ctx: Pick<WebGLDrawContext, 'save' | 'restore' | 'font' | 'fontKerning' | 'measureText'>
}

// Drawing functions use editor scene coordinates. The caller installs the
// viewport transform; scale converts scene units to CSS pixels.
export type EditorDrawContext = {
    ctx: WebGLDrawContext
    scale: number
    pixelRatio: number
    bounds: CanvasBounds
    ups: number
    state: State
    /** Present only in the dynamic chart's Composed main editor. */
    composed?: ReturnType<typeof createComposedLayout>
    /** Slides drawn outside the state, such as a paste's ghost. */
    slideInfos?: StoreSlides['info']
    defaultGroupId: GroupId | undefined
    showStageName: boolean
    showGroupName: boolean
    /** Adds a narrow black outline to whole names for contrast over chart artwork. */
    nameContrast: boolean
    recentlyActive: boolean
    fontFamily: string
    fontMiddle: number
    figureMiddle: number
    /** Collects the frame's names to place them together; without it they draw at once. */
    names?: NameLayer
    /** Draws names from rasterised sprites; without it they draw as text. */
    nameSprites?: LabelSprites
}
