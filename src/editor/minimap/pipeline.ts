// The minimap's content pipeline: one pass per animation frame decides
// between a band redraw and a full redraw. A full redraw runs in frame slices into a CPU back
// buffer, rasterising each slice inside the slice, and reaches the front canvas in one blit.

import { shallowRef, type ShallowRef } from 'vue'
import type { State } from '../../state'
import { isSameTempo, type BpmIntegral } from '../../state/integrals/bpms'
import { getComposedLayout } from '../composedView'
import {
    bandKeyRange,
    bandsTooTall,
    diffGrids,
    gridsOf,
    keysToBands,
    type DrawnGrids,
} from './diff'
import {
    backingSize,
    capScale,
    createMapping,
    type MinimapGeometry,
    type MinimapMapping,
} from './mapping'
import {
    collectConnectors,
    collectNotes,
    createPainter,
    type Painter,
    type PaintSource,
} from './paint'
import { computeEnd } from './range'

export type MinimapSources = { shown: State; live: State; peeking: boolean }

export type MinimapPipeline = {
    /** CSS size of the canvas and devicePixelRatio; caps and the 100 ms debounce are applied here. */
    setGeometry: (width: number, height: number, devicePixelRatio: number) => void
    /** Coalesced to one pass in the next frame. */
    setSources: (sources: MinimapSources) => void
    /** The mapping the front canvas shows, at the current CSS size; undefined before the first swap. */
    mapping: Readonly<ShallowRef<MinimapMapping | undefined>>
    /** Whether nothing is waiting: no pass, no job and no geometry change. Specs wait on it. */
    isIdle: () => boolean
    dispose: () => void
}

/** Recording time after which a slice stops. */
export const SLICE_MS = 2
/** A geometry change waits this long for the last one before a full redraw starts. */
export const GEOMETRY_DEBOUNCE_MS = 100
/** Notes between clock checks in a slice. */
const NOTE_CHECK = 64

/** Read through `editorTest.appImport` by the specs and the probe. */
export const minimapStats = {
    passes: 0,
    fullJobs: 0,
    bandPasses: 0,
    /** Content paints: one per swap and one per band redraw. */
    paints: 0,
    /** B and C increment it. */
    annotationPaints: 0,
    /** The range of what the front canvas shows, in seconds. */
    end: 0,
    lastFull: {
        totalMs: 0,
        slices: 0,
        maxSliceMs: 0,
        swapMs: 0,
        items: 0,
        /** Recording time over all slices. */
        recordMs: 0,
        /** Forced rasterisation time over all slices. */
        flushMs: 0,
        /** From the job's start to its swap. */
        wallMs: 0,
    },
    lastBand: { ms: 0, keys: 0, entities: 0 },
}

/** What a canvas was drawn from, to tell a full redraw from bands. */
type Baseline = {
    grids: DrawnGrids
    bpms: BpmIntegral[]
    /** The Composed stage map, or `'basic'`. */
    layoutKey: unknown
    end: number
    geometry: MinimapGeometry
}

type Job = {
    baseline: Baseline
    source: PaintSource
    painter?: Painter
    connectors: ReturnType<typeof collectConnectors>
    notes: ReturnType<typeof collectNotes>
    rules: boolean
    connectorIndex: number
    noteIndex: number
    frame: number | undefined
    startedAt: number
    slices: number
    maxSliceMs: number
    sliceMs: number
    recordMs: number
    flushMs: number
}

const sameGeometry = (a: MinimapGeometry, b: MinimapGeometry) =>
    a.width === b.width && a.height === b.height && a.scale === b.scale

const now = () => performance.now()

const flush = (context: CanvasRenderingContext2D) => context.getImageData(0, 0, 1, 1)

export const createMinimapPipeline = (front: HTMLCanvasElement): MinimapPipeline => {
    // Both canvases rasterise on the CPU: a slice's drawing is then done inside the slice, and a
    // band on the front produces the same pixels as the full redraw it stands in for.
    const frontContext = front.getContext('2d', { willReadFrequently: true })
    const back = document.createElement('canvas')
    const backContext = back.getContext('2d', { willReadFrequently: true })
    const mapping = shallowRef<MinimapMapping>()

    let sources: MinimapSources | undefined
    /** The latest CSS size, at once. */
    let requested: MinimapGeometry | undefined
    /** The geometry full redraws are made for, after the debounce. */
    let target: MinimapGeometry | undefined
    let drawn: Baseline | undefined
    let job: Job | undefined
    let passFrame: number | undefined
    let geometryTimer: ReturnType<typeof setTimeout> | undefined
    let disposed = false

    const cancelJob = () => {
        if (job?.frame !== undefined) cancelAnimationFrame(job.frame)
        job = undefined
    }

    const schedulePass = () => {
        if (disposed || passFrame !== undefined) return
        passFrame = requestAnimationFrame(runPass)
    }

    const compatible = (baseline: Baseline, shown: State, layoutKey: unknown, end: number) =>
        !!target &&
        sameGeometry(baseline.geometry, target) &&
        baseline.end === end &&
        baseline.layoutKey === layoutKey &&
        isSameTempo(baseline.bpms, shown.bpms)

    /** Paints one slice of the job; returns whether the job is complete. */
    const runSlice = (running: Job) => {
        if (!backContext) return true
        const start = now()
        if (!running.painter) {
            const { width, height } = backingSize(running.baseline.geometry)
            if (back.width !== width || back.height !== height) {
                back.width = width
                back.height = height
            } else {
                backContext.clearRect(0, 0, width, height)
            }
            backContext.globalAlpha = 1
            backContext.globalCompositeOperation = 'source-over'
            running.painter = createPainter(backContext, running.source)
            const { grid } = running.source.state.store
            running.connectors = collectConnectors(grid.connector, -Infinity, Infinity)
            running.notes = collectNotes(grid.note, -Infinity, Infinity)
        }
        const painter = running.painter
        if (!running.rules) {
            painter.rules(back.height)
            running.rules = true
        }
        let stopped = false
        while (!stopped && running.connectorIndex < running.connectors.length) {
            const connector = running.connectors[running.connectorIndex++]
            if (connector) painter.connector(connector)
            stopped = now() - start >= SLICE_MS
        }
        while (!stopped && running.noteIndex < running.notes.length) {
            const note = running.notes[running.noteIndex++]
            if (note) painter.note(note)
            if (running.noteIndex % NOTE_CHECK === 0) stopped = now() - start >= SLICE_MS
        }
        const recorded = now()
        flush(backContext)
        const end = now()
        running.slices++
        running.recordMs += recorded - start
        running.flushMs += end - recorded
        running.sliceMs += end - start
        running.maxSliceMs = Math.max(running.maxSliceMs, end - start)
        return (
            running.connectorIndex >= running.connectors.length &&
            running.noteIndex >= running.notes.length
        )
    }

    const swap = (running: Job) => {
        if (!frontContext || job !== running) return
        const start = now()
        const { width, height } = backingSize(running.baseline.geometry)
        if (front.width !== width || front.height !== height) {
            front.width = width
            front.height = height
        }
        frontContext.globalCompositeOperation = 'copy'
        frontContext.drawImage(back, 0, 0)
        frontContext.globalCompositeOperation = 'source-over'
        flush(frontContext)
        const end = now()
        job = undefined
        drawn = running.baseline
        mapping.value = running.source.mapping
        const full = minimapStats.lastFull
        full.swapMs = end - start
        full.totalMs = running.sliceMs + full.swapMs
        full.slices = running.slices
        full.maxSliceMs = running.maxSliceMs
        full.items = running.connectors.length + running.notes.length
        full.recordMs = running.recordMs
        full.flushMs = running.flushMs
        full.wallMs = end - running.startedAt
        minimapStats.end = running.baseline.end
        minimapStats.paints++
        // Edits made meanwhile land as bands (or as another job).
        schedulePass()
    }

    const step = (running: Job) => {
        running.frame = undefined
        if (job !== running) return
        try {
            const done = runSlice(running)
            running.frame = requestAnimationFrame(() => {
                running.frame = undefined
                if (done) swap(running)
                else step(running)
            })
        } catch (error) {
            cancelJob()
            throw error
        }
    }

    const startFull = (
        shown: State,
        layout: PaintSource['layout'],
        layoutKey: unknown,
        end: number,
    ) => {
        if (!target) return
        cancelJob()
        minimapStats.fullJobs++
        const running: Job = {
            baseline: {
                grids: gridsOf(shown),
                bpms: shown.bpms,
                layoutKey,
                end,
                geometry: target,
            },
            source: { state: shown, layout, mapping: createMapping(target, end) },
            connectors: [],
            notes: [],
            rules: false,
            connectorIndex: 0,
            noteIndex: 0,
            frame: undefined,
            startedAt: now(),
            slices: 0,
            maxSliceMs: 0,
            sliceMs: 0,
            recordMs: 0,
            flushMs: 0,
        }
        job = running
        step(running)
    }

    /**
     * Repaints the rows of the changed keys; false when a full redraw is cheaper. Each band is
     * painted whole items at a time into the back buffer, then its rows are copied to the front.
     * A canvas clip would move the antialiased edges of slanted bodies, so a band would differ
     * from the full redraw it stands in for; unclipped, every item rasterises as it does there.
     */
    const paintBands = (
        shown: State,
        layout: PaintSource['layout'],
        keys: number[],
        current: Baseline,
    ) => {
        if (!frontContext || !backContext) return true
        const start = now()
        const shownMapping = createMapping(current.geometry, current.end)
        const bands = keysToBands(keys, shown.bpms, shownMapping)
        const { width, height } = backingSize(current.geometry)
        if (bandsTooTall(bands, height)) return false
        const source: PaintSource = { state: shown, layout, mapping: shownMapping }
        const { grid } = shown.store
        let entities = 0
        backContext.globalAlpha = 1
        backContext.globalCompositeOperation = 'source-over'
        for (const band of bands) {
            const { lo, hi } = bandKeyRange(band, shown.bpms, shownMapping)
            const rows = band.bottom - band.top
            backContext.clearRect(0, band.top, width, rows)
            const painter = createPainter(backContext, source)
            painter.rules(height)
            for (const connector of collectConnectors(grid.connector, lo, hi)) {
                painter.connector(connector)
                entities++
            }
            for (const note of collectNotes(grid.note, lo, hi)) {
                painter.note(note)
                entities++
            }
            // Clearing first makes the copy exact: over nothing, source-over is the source.
            flush(backContext)
            frontContext.clearRect(0, band.top, width, rows)
            frontContext.drawImage(back, 0, band.top, width, rows, 0, band.top, width, rows)
        }
        flush(frontContext)
        minimapStats.bandPasses++
        minimapStats.paints++
        minimapStats.lastBand = { ms: now() - start, keys: keys.length, entities }
        return true
    }

    function runPass() {
        passFrame = undefined
        if (disposed || !sources || !target) return
        minimapStats.passes++
        const start = now()
        const { shown, live, peeking } = sources
        const layout = getComposedLayout(shown)
        const layoutKey: unknown = layout?.stages ?? 'basic'
        const end = computeEnd(shown, live, peeking)
        if (job) {
            // Edits during a job do not restart it. What would make its output wrong does.
            if (!compatible(job.baseline, shown, layoutKey, end))
                startFull(shown, layout, layoutKey, end)
            return
        }
        if (!drawn || !compatible(drawn, shown, layoutKey, end)) {
            startFull(shown, layout, layoutKey, end)
            return
        }
        const next = gridsOf(shown)
        const keys = diffGrids(drawn.grids, next)
        if (keys === 'full' || (keys.length && !paintBands(shown, layout, keys, drawn))) {
            startFull(shown, layout, layoutKey, end)
            return
        }
        // The diff and the bands count as one pass.
        if (keys.length) minimapStats.lastBand.ms = now() - start
        drawn = { ...drawn, grids: next, bpms: shown.bpms }
    }

    const restart = () => {
        // A lost context has lost its pixels: nothing drawn is left to diff against.
        cancelJob()
        drawn = undefined
        schedulePass()
    }
    front.addEventListener('contextrestored', restart)

    return {
        setGeometry(width, height, devicePixelRatio) {
            if (disposed || !(width >= 1) || !(height >= 1)) return
            const next = { width, height, scale: capScale(devicePixelRatio, height) }
            if (requested && sameGeometry(requested, next)) return
            requested = next
            clearTimeout(geometryTimer)
            if (!target) {
                target = next
                schedulePass()
                return
            }
            // Until the job swaps, CSS stretches the front canvas, and the mapping follows it.
            if (drawn)
                mapping.value = createMapping({ ...next, scale: drawn.geometry.scale }, drawn.end)
            geometryTimer = setTimeout(() => {
                geometryTimer = undefined
                target = requested
                schedulePass()
            }, GEOMETRY_DEBOUNCE_MS)
        },

        setSources(next) {
            sources = next
            schedulePass()
        },

        mapping,

        isIdle: () => passFrame === undefined && !job && geometryTimer === undefined,

        dispose() {
            disposed = true
            cancelJob()
            clearTimeout(geometryTimer)
            if (passFrame !== undefined) cancelAnimationFrame(passFrame)
            passFrame = undefined
            front.removeEventListener('contextrestored', restart)
            front.width = 0
            front.height = 0
            back.width = 0
            back.height = 0
            mapping.value = undefined
            drawn = undefined
        },
    }
}
