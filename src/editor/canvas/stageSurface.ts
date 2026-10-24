import type { WebGLDrawContext } from '../../rendering/context'
import type { Matrix } from '../../rendering/matrix'
import { StageTriangles, type StageMesh } from '../../rendering/stageMesh'
import { timeToBeat } from '../../state/integrals/bpms'
import type { Range } from '../../utils/range'
import type { ScopeLookup } from '../scopeRules'
import {
    drawComposedStages,
    supportsStageTriangles,
    traceComposedStages,
    type StageOutput,
} from './stages'
import { deviceSize } from './surface'
import type { EditorDrawContext } from './types'

// Tiles are this many CSS pixels of chart time tall, rounded to whole device pixels.
const TILE_CSS = 128
// Retained tiles beyond the visible ones, oldest use first out.
const MAX_TILES = 96
// Packed vertex floats across retained tiles (32 MiB); visible tiles are always kept.
const MAX_FLOATS = 8 * 1024 * 1024
// Tiles reach this many view widths beyond each side of the view they were built for.
const MARGIN = 0.25

type Segment = { mesh: StageMesh; floats: number } | ((context: EditorDrawContext) => void)

type Tile = { segments: Segment[]; floats: number }

const sameKey = (a: readonly unknown[] | undefined, b: readonly unknown[]) =>
    a?.length === b.length && b.every((value, i) => value === a[i])

/**
 * Retains the composed stage geometry in tiles of chart time, packed at the
 * chart's device scale. A scroll or pan only offsets the tiles; a tile is
 * built when it first comes into view, and while the view moves, the next tile
 * ahead is built in a frame that built none.
 */
export const createStageSurface = () => {
    let ctx: WebGLDrawContext | undefined
    let key: readonly unknown[] | undefined
    // The horizontal lane range the tiles were built for.
    let left = 0
    let right = 0
    const tiles = new Map<number, Tile>()
    let floats = 0
    let lastTop: number | undefined

    const releaseTile = (tile: Tile) => {
        for (const segment of tile.segments)
            if (typeof segment !== 'function') ctx?.releaseStageMesh(segment.mesh)
        floats -= tile.floats
    }
    const clear = () => {
        for (const tile of tiles.values()) releaseTile(tile)
        tiles.clear()
        floats = 0
        ctx = undefined
        key = undefined
        lastTop = undefined
    }

    return {
        draw(
            context: EditorDrawContext,
            width: number,
            height: number,
            beats: Range<number>,
            scope: ScopeLookup,
            laneDivision: number,
        ) {
            const { composed, bounds, pixelRatio, scale, ups } = context
            if (!composed) {
                clear()
                return
            }
            const [w, h] = deviceSize(width, height, pixelRatio)
            const sx = scale * (w / width)
            const sy = scale * (h / height)
            const size = Math.max(1, Math.round(TILE_CSS * pixelRatio))
            if (
                ![sx, sy, scale, ups, pixelRatio, bounds.l, bounds.r, bounds.t, bounds.b].every(
                    Number.isFinite,
                ) ||
                !sx ||
                !sy ||
                !ups ||
                !(pixelRatio > 0) ||
                !supportsStageTriangles(context)
            ) {
                clear()
                drawComposedStages(context, beats, scope, laneDivision)
                return
            }
            if (context.ctx.isContextLost()) {
                clear()
                return
            }
            // Everything the geometry depends on, besides which tile it is.
            const nextKey = [
                context.ctx,
                context.ctx.resourceOwner,
                composed.stages,
                context.state.bpms,
                sx,
                sy,
                scale,
                ups,
                pixelRatio,
                laneDivision,
                ...[...composed.stages.keys()].map((id) => scope.stage(id)),
            ]
            // Tiles reach past the view on both sides. A pan past them builds them again around the view.
            if (!sameKey(key, nextKey) || bounds.l < left || bounds.r > right) {
                clear()
                key = nextKey
                ctx = context.ctx
                const margin = (bounds.r - bounds.l) * MARGIN
                left = bounds.l - margin
                right = bounds.r + margin
            }
            const target = context.ctx

            // Tile k covers device rows [k * size, (k + 1) * size) of the unscrolled scene.
            // Borders can reach a few pixels past their slice.
            const reach = 4 * pixelRatio
            const top = bounds.t * sy
            const first = Math.floor((top - reach) / size)
            const last = Math.floor((bounds.b * sy + reach) / size)
            const edge = (k: number) =>
                timeToBeat(context.state.bpms, Math.max(0, (k * size) / sy / ups))
            const build = (k: number): Tile => {
                const matrix: Matrix = [sx, 0, 0, sy, 0, -k * size]
                const segments: Segment[] = []
                let count = 0
                const output: StageOutput = {
                    triangles: new StageTriangles(matrix),
                    flush(vertices) {
                        if (!vertices.length) return
                        segments.push({
                            mesh: target.createStageMesh(vertices, matrix),
                            floats: vertices.length,
                        })
                        count += vertices.length
                    },
                    slice(draw) {
                        segments.push(draw)
                    },
                }
                const a = edge(k)
                const b = edge(k + 1)
                traceComposedStages(
                    { ...context, bounds: { ...bounds, l: left, r: right, w: right - left } },
                    { min: Math.min(a, b), max: Math.max(a, b) },
                    scope,
                    laneDivision,
                    output,
                )
                const tile = { segments, floats: count }
                floats += count
                tiles.set(k, tile)
                return tile
            }

            // Draw in chart time order, as one draw of the whole view would.
            let built = 0
            const order = ups < 0 ? -1 : 1
            const x = -bounds.l * sx
            for (let index = 0; index <= last - first; index++) {
                const k = order > 0 ? first + index : last - index
                let tile = tiles.get(k)
                if (tile) {
                    // Most recent use last.
                    tiles.delete(k)
                    tiles.set(k, tile)
                } else {
                    tile = build(k)
                    built++
                }
                const y = k * size - top
                for (const segment of tile.segments) {
                    if (typeof segment === 'function') segment(context)
                    else target.drawStageMesh(segment.mesh, x, y)
                }
            }
            // While the view moves, prepare the next tile ahead in a frame that built none.
            const moved = lastTop === undefined ? 0 : top - lastTop
            lastTop = top
            if (!built && moved) {
                const ahead = moved > 0 ? last + 1 : first - 1
                if (!tiles.has(ahead)) build(ahead)
            }
            // Release the oldest tiles out of view past the limits.
            for (const [k, tile] of tiles) {
                if (tiles.size <= MAX_TILES && floats <= MAX_FLOATS) break
                if (k >= first && k <= last) continue
                tiles.delete(k)
                releaseTile(tile)
            }
        },
        clear,
        /** Retained tile count and packed floats, for tests. */
        get stats() {
            return { tiles: tiles.size, floats }
        },
    }
}
