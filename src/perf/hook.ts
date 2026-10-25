// Perf builds only: what `scripts/perf/run.mjs` drives and reads (docs/performance-testing.md).
import {
    closeElevationEditor,
    isElevationEditorOpen,
    openElevationEditor,
} from '../editor/elevation/state'
import { minimapStats } from '../editor/minimap/pipeline'
import { changePlayerSpeed, startOrStopPlayer } from '../editor/player'
import { view } from '../editor/view'
import { replaceState, state } from '../history'
import { getAllEntities } from '../history/store'
import { isPlaying } from '../player'
import { previewHost } from '../preview/worker/host'
import { peekDrawContext } from '../rendering/context'
import type { PathGraphicsCache } from '../rendering/pathGraphics'
import { settings } from '../settings'
import { beatToTime } from '../state/integrals/bpms'
import { perfSamples } from './probe'

declare global {
    // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
    interface Window {
        nsePerf?: typeof nsePerf
    }
}

const nsePerf = {
    view,
    settings,
    state,
    isPlaying,
    /** Which host draws the preview. */
    previewHost: (): 'main' | 'worker' => previewHost.kind,
    isElevationEditorOpen,
    minimapStats,
    perfSamples,
    startOrStopPlayer,
    changePlayerSpeed,
    openElevationEditor,
    closeElevationEditor,
    /** Selects the `count` plain notes nearest `time`; their screen points, nearest first. */
    selectNear(time: number, count: number) {
        const bpms = state.value.bpms
        const notes = [...getAllEntities()]
            .filter((e) => e.type === 'note' && !e.isAttached)
            .map((e) => ({ e, t: beatToTime(bpms, e.beat) }))
            .sort((a, b) => Math.abs(a.t - time) - Math.abs(b.t - time))
            .slice(0, count)
        replaceState({ ...state.value, selectedEntities: notes.map(({ e }) => e) })
        return notes.map(({ e, t }) => {
            const n = e as unknown as { left: number; size: number }
            const lane = n.left + n.size / 2
            return {
                x: view.x + ((lane - view.lane) / settings.width + 0.5) * view.w,
                y: 0.5 * view.h + view.y - (t - view.time) * settings.pps,
            }
        })
    },
    /** The last entity's time. */
    chartEnd() {
        const bpms = state.value.bpms
        let end = 0
        for (const e of getAllEntities()) end = Math.max(end, beatToTime(bpms, e.beat))
        return end
    },
    /** The chart and overlay canvases' path caches: their counters and resident bytes. */
    pathCaches() {
        const out: Record<string, PathGraphicsCache['stats'] & { bytes: number; pinned: number }> =
            {}
        for (const name of ['chart', 'overlay']) {
            const canvas = document.querySelector<HTMLCanvasElement>(`canvas.editor-${name}`)
            const context = canvas && peekDrawContext(canvas)
            if (!context) continue
            const { paths } = context as unknown as { paths: PathGraphicsCache }
            out[name] = { ...paths.stats, bytes: paths.retainedBytes, pinned: paths.pinnedBytes }
        }
        return out
    },
    /** Selects every note and connector, or nothing. */
    selectNotes(on: boolean) {
        const selectedEntities = on
            ? [...getAllEntities()].filter((e) => e.type === 'note' || e.type === 'connector')
            : []
        replaceState({ ...state.value, selectedEntities })
        return selectedEntities.length
    },
}
window.nsePerf = nsePerf
