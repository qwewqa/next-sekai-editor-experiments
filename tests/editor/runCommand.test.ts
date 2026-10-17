import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import type { Command } from '../../src/editor/commands'
import { runCommand } from '../../src/editor/commands/runCommand'
import { peek, resetStates } from '../../src/history/stack'
import type { State } from '../../src/state'

const root = new URL('../../', import.meta.url)

const sources = readdirSync(new URL('src/', root), { recursive: true, encoding: 'utf8' })
    .map((path) => `src/${path.replaceAll('\\', '/')}`)
    .filter((path) => /\.(ts|vue)$/.test(path))
    .map((path) => ({ path, source: readFileSync(new URL(path, root), 'utf8') }))

const count = (source: string, pattern: RegExp) => source.match(pattern)?.length ?? 0

test('commands run only through runCommand', () => {
    const callers = sources
        .filter(({ source }) => source.includes('.execute('))
        .map(({ path }) => path)
    assert.deepEqual(callers, ['src/editor/commands/runCommand.ts'])
})

const fakeCommand = (readOnly: boolean) => {
    const runs: number[] = []
    const command: Command = {
        title: () => '',
        icon: { is: {} },
        execute: () => {
            runs.push(1)
        },
        ...(readOnly && { readOnly: true }),
    }
    return { command, runs }
}

test('while peeking, runCommand runs only read-only commands', () => {
    resetStates({ isDirty: false, name: () => '', state: {} as State })
    const edit = fakeCommand(false)
    const view = fakeCommand(true)

    runCommand(edit.command)
    runCommand(view.command)
    assert.equal(edit.runs.length, 1)
    assert.equal(view.runs.length, 1)

    peek.value = { source: 'test', state: {} as State }
    runCommand(edit.command)
    runCommand(view.command)
    assert.equal(edit.runs.length, 1)
    assert.equal(view.runs.length, 2)
    peek.value = undefined
})

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
 */
type Gate =
    'command' | 'tool' | 'select' | 'selection' | 'drag' | 'panel' | 'elevation' | 'levelInfo'

const callSites: Record<string, { push: number; replace: number; gate: Gate }> = {
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
    'src/editor/commands/properties/index.ts': { push: 1, replace: 0, gate: 'levelInfo' },
    'src/editor/commands/scaleSelection/session.ts': { push: 1, replace: 0, gate: 'command' },
    'src/editor/commands/splitHold/index.ts': { push: 1, replace: 0, gate: 'command' },
    'src/editor/controls/gestures/recognizers/drag.ts': { push: 0, replace: 1, gate: 'drag' },
    'src/editor/controls/index.ts': { push: 0, replace: 1, gate: 'selection' },
    'src/editor/elevation/ElevationEditor.vue': { push: 1, replace: 3, gate: 'elevation' },
    'src/editor/elevation/actions.ts': { push: 1, replace: 0, gate: 'elevation' },
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
    // Enabling dynamic stages, from the stage commands and the stage event tools.
    'src/history/dynamicStages.ts': { push: 1, replace: 0, gate: 'command' },
}

test('every direct pushState and replaceState call site is listed with its gate', () => {
    const found = Object.fromEntries(
        sources.flatMap(({ path, source }) => {
            const push = count(source, /\bpushState\(/g)
            const replace = count(source, /\breplaceState\(/g)
            return push || replace ? [[path, { push, replace }]] : []
        }),
    )
    const listed = Object.fromEntries(
        Object.entries(callSites).map(([path, { push, replace }]) => [path, { push, replace }]),
    )
    assert.deepEqual(found, listed)
})
