// The direct pushState and replaceState call sites, shared by runCommand.test.ts and
// peekGate.test.ts.

/**
 * Every direct pushState and replaceState call, by file, and what keeps it from writing while
 * peeking (§1.4.11): pushState then throws in development and tests, and replaceState changes
 * only the peeked state.
 * - command: runs from a command runCommand refuses while peeking
 * - tool: a tool other than select, suspended while peeking
 * - select: the select tool, view-only while peeking
 * - selection: replaceState of the selection, which a peek keeps for itself
 * - drag: a drag, which a peek cancels
 * - panel: a manager or sidebar panel, or its dialogs, disabled while peeking
 * - elevation: the Elevation Editor, closed or behind an overlay while peeking
 * - levelInfo: Level Info, read-only while peeking
 * - restore: Restore of a History entry, which leaves the peek first
 * - attach: audio brought back to the live state, which waits while a peek shows
 * - pick: a Choose Audio… pick, refused while peeking and applied only while no peek shows
 */
export type Gate =
    | 'command'
    | 'tool'
    | 'select'
    | 'selection'
    | 'drag'
    | 'panel'
    | 'elevation'
    | 'levelInfo'
    | 'restore'
    | 'attach'
    | 'pick'

export const callSites: Record<string, { push: number; replace: number; gate: Gate }> = {
    'src/editor/LevelEditorContextMenu.vue': { push: 0, replace: 1, gate: 'selection' },
    'src/editor/commands/bgm/index.ts': { push: 1, replace: 0, gate: 'command' },
    'src/editor/commands/combineNotes/index.ts': { push: 1, replace: 0, gate: 'command' },
    'src/editor/commands/cut/index.ts': { push: 1, replace: 1, gate: 'command' },
    'src/editor/commands/deselect/index.ts': { push: 0, replace: 1, gate: 'selection' },
    'src/editor/commands/flip/index.ts': { push: 1, replace: 0, gate: 'command' },
    'src/editor/commands/flipVertical/index.ts': { push: 1, replace: 0, gate: 'command' },
    'src/editor/commands/makeVertical/index.ts': { push: 1, replace: 0, gate: 'command' },
    'src/editor/commands/manageGroups/manageGroups/groupProperties/GroupPropertiesModal.vue': {
        push: 1,
        replace: 0,
        gate: 'panel',
    },
    'src/editor/commands/manageStages/manageStages/stageProperties/StagePropertiesModal.vue': {
        push: 1,
        replace: 0,
        gate: 'panel',
    },
    'src/editor/commands/scaleSelection/session.ts': { push: 1, replace: 0, gate: 'command' },
    'src/editor/commands/splitHold/index.ts': { push: 1, replace: 0, gate: 'command' },
    'src/editor/controls/gestures/recognizers/drag.ts': { push: 0, replace: 1, gate: 'drag' },
    'src/editor/controls/index.ts': { push: 0, replace: 1, gate: 'selection' },
    'src/editor/elevation/ElevationEditor.vue': { push: 1, replace: 3, gate: 'elevation' },
    'src/editor/elevation/actions.ts': { push: 1, replace: 0, gate: 'elevation' },
    'src/editor/levelInfo/apply.ts': { push: 1, replace: 0, gate: 'levelInfo' },
    'src/editor/offscreenIndicators.ts': { push: 0, replace: 1, gate: 'selection' },
    'src/editor/sidebars/default/index.ts': { push: 1, replace: 0, gate: 'panel' },
    'src/editor/tools/bpm/index.ts': { push: 1, replace: 4, gate: 'tool' },
    'src/editor/tools/brush/index.ts': { push: 1, replace: 4, gate: 'tool' },
    'src/editor/tools/eraser.ts': { push: 1, replace: 3, gate: 'tool' },
    'src/editor/tools/events/camera/index.ts': { push: 1, replace: 3, gate: 'tool' },
    'src/editor/tools/events/stage/mask/index.ts': { push: 1, replace: 3, gate: 'tool' },
    'src/editor/tools/events/stage/pivot/index.ts': { push: 1, replace: 3, gate: 'tool' },
    'src/editor/tools/events/stage/style/index.ts': { push: 1, replace: 3, gate: 'tool' },
    'src/editor/tools/events/stage/transform/index.ts': { push: 1, replace: 3, gate: 'tool' },
    'src/editor/tools/generateSlideNotes/index.ts': { push: 1, replace: 2, gate: 'tool' },
    'src/editor/tools/note/index.ts': { push: 1, replace: 3, gate: 'tool' },
    'src/editor/tools/offset/index.ts': { push: 1, replace: 0, gate: 'tool' },
    'src/editor/tools/paste/index.ts': { push: 3, replace: 0, gate: 'tool' },
    'src/editor/tools/select.ts': { push: 1, replace: 5, gate: 'select' },
    'src/editor/tools/slide/index.ts': { push: 1, replace: 3, gate: 'tool' },
    'src/editor/tools/timeScale/index.ts': { push: 1, replace: 4, gate: 'tool' },
    'src/editor/workspace/manager/folders.ts': { push: 1, replace: 0, gate: 'panel' },
    'src/editor/workspace/manager/groups.ts': { push: 2, replace: 0, gate: 'panel' },
    'src/editor/workspace/manager/objects.ts': { push: 0, replace: 1, gate: 'selection' },
    'src/editor/workspace/manager/stages.ts': { push: 2, replace: 0, gate: 'panel' },
    'src/editor/workspace/properties/selectOnly.ts': { push: 0, replace: 1, gate: 'selection' },
    // The BGM attached to the live state once decoded (an opened file's, a stored one), never while peeking.
    'src/editor/media/heldBgm.ts': { push: 0, replace: 1, gate: 'attach' },
    'src/editor/media/applyPick.ts': { push: 1, replace: 0, gate: 'pick' },
    // Enabling dynamic stages, from the stage commands and the stage event tools.
    'src/history/dynamicStages.ts': { push: 1, replace: 0, gate: 'command' },
    'src/history/peek.ts': { push: 1, replace: 0, gate: 'restore' },
    // The perf harness's selection, in perf builds only.
    'src/perf/hook.ts': { push: 0, replace: 2, gate: 'selection' },
}
