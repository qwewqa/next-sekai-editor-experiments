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
import { settings } from '../settings'
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
    isElevationEditorOpen,
    minimapStats,
    perfSamples,
    startOrStopPlayer,
    changePlayerSpeed,
    openElevationEditor,
    closeElevationEditor,
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
