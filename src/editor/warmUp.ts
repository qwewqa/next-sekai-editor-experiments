// Warm-up: once startup is over and the page is idle, the code behind the features most sessions
// reach loads in the background, a group per idle slot. The first use then finds it loaded, and
// a tab left open across a deploy, or one that goes offline, still has it. A user action that
// finds its code missing loads it itself and says so when it cannot (`loadForAction`). A failed
// warm-up load stays silent.
//
// Every module here may run early: none registers a listener, timer or hook, or reads storage,
// when it is imported. Modules the first bundle or the storage modules already load at first paint
// (the project reader, the startup events, the BGM player, Settings, Switch, the Peek effects, the
// sidebars) are not listed. The MP3 encoder and raw export stay cold: they are rare and heavy.

type Load = () => Promise<unknown>

/** Most likely first; a group loads together, in one idle slot. */
export const warmUpGroups: readonly (readonly Load[])[] = [
    // Save, Save As…, Export and Open of a project file.
    [
        () => import('./save/flow'),
        () => import('./save/exportPick'),
        () => import('./commands/exportLevel/build'),
        () => import('./commands/open/project'),
        () => import('../local/startup/open'),
    ],
    // History: the panel, the dialog, the step details and the Timeline's source.
    [
        () => import('./history/HistoryPanel.vue'),
        () => import('./history/HistoryDialog.vue'),
        () => import('./history/StepDetailsModal.vue'),
        () => import('./history/source'),
    ],
    // Recent Sessions, and Restore (its row actions are in the panel).
    [() => import('../local/startup/api'), () => import('../local/locks')],
    // Check File and History.
    [() => import('./check/run')],
    // Loading and drawing the BGM's waveform.
    [() => import('../waveform')],
    // Preview Assets and its file inspection.
    [
        () => import('./commands/previewAssets/PreviewAssetsModal.vue'),
        () => import('../preview/assets/files/inspect'),
    ],
]

export type WarmUpEnv = {
    /** Resolves when startup has left `opening`. */
    startupEnded: () => Promise<void>
    /** Runs a function when the page is idle. */
    idle: (run: () => void) => void
    /** Whether the browser asks pages to save data. */
    saveData: () => boolean
}

/** Loads each group after startup, one per idle slot; a failed load is dropped. */
export const runWarmUp = async (groups: readonly (readonly Load[])[], env: WarmUpEnv) => {
    if (env.saveData()) return
    await env.startupEnded()
    for (const group of groups) {
        await new Promise<void>((resolve) => {
            env.idle(resolve)
        })
        await Promise.allSettled(group.map((load) => load()))
    }
}

const idle = (run: () => void) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1000 })
    else setTimeout(run, 1000)
}

const saveData = () =>
    (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true

let started = false

/** Starts the warm-up, once: `startupEnded` is the gate's. */
export const warmUp = (startupEnded: () => Promise<void>) => {
    if (started) return
    started = true
    void runWarmUp(warmUpGroups, { startupEnded, idle, saveData })
}
