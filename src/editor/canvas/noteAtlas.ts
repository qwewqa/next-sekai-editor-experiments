import type { NoteAtlasRegion, RenderSurface, WebGLDrawContext } from '../../rendering/context'

const PAGE_SIZE = 1024
// Bound logical page pixels, including unused packing space, across this atlas's
// rendering owners. Resolved RGBA costs up to 16 MiB; MSAA attachments are additional.
const MAX_PIXELS = 4 * 1024 * 1024
const GUTTER = 1
const ROW_STEP = 8

type Span = { x: number; width: number }
type Row = { y: number; height: number; free: Span[] }
type Page = {
    surface: RenderSurface
    owner: object
    rows: Row[]
    usedHeight: number
    count: number
    pixels: number
    standalone: boolean
    disposed: boolean
    regions: Set<NoteAtlasRegion>
}

export type NoteAtlasSlot = {
    surface: RenderSurface
    x: number
    y: number
    width: number
    height: number
    region: NoteAtlasRegion | undefined
    valid: () => boolean
    release: () => void
}

/** Note artwork shares a few textures so consecutive notes can draw in one GPU call. */
export const createNoteAtlas = () => {
    const pages: Page[] = []
    let pixels = 0

    const dispose = (page: Page) => {
        if (page.disposed) return
        page.disposed = true
        for (const region of page.regions) region.release()
        page.regions.clear()
        page.surface.dispose()
        pixels -= page.pixels
        const index = pages.indexOf(page)
        if (index !== -1) pages.splice(index, 1)
    }
    const valid = (page: Page) => {
        if (page.disposed) return false
        const ctx = page.surface.getContext()
        return !ctx.isContextLost() && ctx.resourceOwner === page.owner
    }

    const take = (page: Page, width: number, height: number) => {
        if (page.standalone) return
        const packedWidth = width + GUTTER * 2
        const packedHeight = height + GUTTER * 2
        // Prefer a short row to leave taller rows useful for flick arrows.
        const rows = page.rows
            .filter((row) => row.height >= packedHeight)
            .sort((a, b) => a.height - b.height)
        let row = rows.find((row) => row.free.some((span) => span.width >= packedWidth))
        if (!row) {
            const rowHeight = Math.ceil(packedHeight / ROW_STEP) * ROW_STEP
            if (page.usedHeight + rowHeight > page.surface.height) return
            row = {
                y: page.usedHeight,
                height: rowHeight,
                free: [{ x: 0, width: page.surface.width }],
            }
            page.rows.push(row)
            page.usedHeight += rowHeight
        }
        const index = row.free.findIndex((span) => span.width >= packedWidth)
        const span = row.free[index]
        if (!span) return
        const x = span.x
        span.x += packedWidth
        span.width -= packedWidth
        if (!span.width) row.free.splice(index, 1)
        return { row, x, width: packedWidth }
    }

    return {
        allocate(ctx: WebGLDrawContext, width: number, height: number): NoteAtlasSlot | undefined {
            if (width > ctx.maxSurfaceSize || height > ctx.maxSurfaceSize) return
            // A restored context has a new owner even if its old surfaces report healthy.
            for (const page of [...pages]) if (!valid(page)) dispose(page)
            const pageSize = Math.min(PAGE_SIZE, ctx.maxSurfaceSize)
            const standalone =
                width + GUTTER * 2 > pageSize ||
                Math.ceil((height + GUTTER * 2) / ROW_STEP) * ROW_STEP > pageSize
            let page: Page | undefined
            let position: ReturnType<typeof take>
            if (!standalone) {
                for (const candidate of pages) {
                    if (candidate.owner !== ctx.resourceOwner) continue
                    position = take(candidate, width, height)
                    if (!position) continue
                    page = candidate
                    break
                }
            }
            if (!page) {
                const pageWidth = standalone ? width : pageSize
                const pageHeight = standalone ? height : pageSize
                const required = pageWidth * pageHeight
                if (pixels + required > MAX_PIXELS) return
                page = {
                    surface: ctx.createSurface(pageWidth, pageHeight),
                    owner: ctx.resourceOwner,
                    rows: [],
                    usedHeight: 0,
                    count: 0,
                    pixels: required,
                    standalone,
                    disposed: false,
                    regions: new Set(),
                }
                pages.push(page)
                pixels += required
                position = standalone ? undefined : take(page, width, height)
            }
            const allocatedPage = page
            const allocatedPosition = position
            allocatedPage.count++
            let released = false
            const x = allocatedPosition ? allocatedPosition.x + GUTTER : 0
            const y = allocatedPosition ? allocatedPosition.row.y + GUTTER : 0
            const region = allocatedPage.surface
                .getContext()
                .createNoteAtlasRegion(x, y, width, height)
            if (region) allocatedPage.regions.add(region)
            return {
                surface: allocatedPage.surface,
                x,
                y,
                width,
                height,
                region,
                valid: () =>
                    !released &&
                    valid(allocatedPage) &&
                    (!region || (!region.texture.destroyed && !region.texture.source.destroyed)),
                release() {
                    if (released) return
                    released = true
                    if (region) {
                        allocatedPage.regions.delete(region)
                        region.release()
                    }
                    if (allocatedPage.disposed) return
                    if (--allocatedPage.count === 0) {
                        dispose(allocatedPage)
                        return
                    }
                    if (!allocatedPosition) return
                    const { row, x, width } = allocatedPosition
                    row.free.push({ x, width })
                    row.free.sort((a, b) => a.x - b.x)
                    // Adjacent released slots become one span for wider future notes.
                    for (let index = 1; index < row.free.length;) {
                        const left = row.free[index - 1]
                        const right = row.free[index]
                        if (left && left.x + left.width === right?.x) {
                            left.width += right.width
                            row.free.splice(index, 1)
                        } else index++
                    }
                },
            }
        },
        clear() {
            for (const page of [...pages]) dispose(page)
        },
    }
}
