import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { callSites } from './peekCallSites'

// The enumerated test (Part 1 §1.11.5): every command, read from the registry's source, is on
// exactly one of §1.4.11's lists and carries the flag the list gives it; every command entry
// point goes through runCommand; and every direct pushState site is gated (runCommand.test.ts
// lists them; Restore's gate is exercised in peek.test.ts, and other gates are inspected here).

const root = new URL('../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')

/** Allowed while peeking: `readOnly` (§1.4.11's Allowed list, as built so far). */
const allowed = [
    'copy',
    'play',
    'stop',
    'scrollLeft',
    'scrollRight',
    'scrollUp',
    'scrollDown',
    'scrollPageUp',
    'scrollPageDown',
    'zoomXIn',
    'zoomXOut',
    'zoomYIn',
    'zoomYOut',
    'jumpUp',
    'jumpDown',
    'fullscreen',
    'settings',
    'help',
    'deselect',
    'select',
    'cycleVisibilities',
    'noteVisibility',
    'bpmVisibility',
    'timeScaleVisibility',
    'cameraEventVisibility',
    'stageMaskEventVisibility',
    'stagePivotEventVisibility',
    'stageStyleEventVisibility',
    'stageTransformEventVisibility',
    'division1',
    'division2',
    'division3',
    'division4',
    'division6',
    'division8',
    'division12',
    'division16',
    'divisionCustom',
    'laneDivision1',
    'laneDivision2',
    'laneDivision3',
    'laneDivision4',
    'laneDivision6',
    'laneDivision8',
    'laneDivision12',
    'laneDivision16',
    'laneDivisionCustom',
    'snapping',
    'laneSnapping',
    'laneLimitNone',
    'laneLimitSix',
    'laneLimitCustom',
    'speedUp',
    'speedDown',
    'toggleBgmVolume',
    'toggleSfxVolume',
    'editorLayout',
    'utilities',
    'openContextMenu',
    // Level Info opens read-only.
    'properties',
    // The live session.
    'save',
    'saveAs',
    'exportLevel',
    // A device setting.
    'previewAssets',
    // Focus and visibility of groups and stages (stage ones refuse enabling dynamic stages).
    'groupPrev',
    'groupNext',
    'groupAll',
    'stagePrev',
    'stageNext',
    'stageAll',
    // The History panel's own command (5-panel).
    'history',
    // The change view's (Step 5).
    'showChange',
    'editsHere',
]

/** Leave the peek first, then run: `leavesPeek`. */
const leaving = ['open', 'reset', 'undo', 'redo']

/** Refused while peeking: offset, elevation as a tool, the managers and every chart edit. */
const refused = [
    'bgm',
    'offset',
    'elevation',
    'manageGroups',
    'manageStages',
    'eraser',
    'brush',
    'paste',
    'cut',
    'deleteSelection',
    'flip',
    'flipVertical',
    'scaleBeat',
    'scaleElevation',
    'scaleWidth',
    'makeVertical',
    'combineNotes',
    'splitHold',
    'increaseNoteSize',
    'decreaseNoteSize',
    'note',
    'note0',
    'note1',
    'note2',
    'note3',
    'slide',
    'slide0',
    'slide1',
    'slide2',
    'slide3',
    'slide4',
    'generateSlideNotes',
    'bpm',
    'timeScale',
    'event',
    'cameraEvent',
    'stageMaskEvent',
    'stagePivotEvent',
    'stageStyleEvent',
    'stageTransformEvent',
]

const resolveModule = (from: string, specifier: string) => {
    const base = new URL(specifier.replace(/\.ts$/, ''), new URL(from, root))
    for (const suffix of ['.ts', '/index.ts']) {
        const url = new URL(base.href + suffix)
        if (existsSync(url)) return url.href.slice(root.href.length)
    }
    throw new Error(`Cannot resolve ${specifier} from ${from}`)
}

/** The module each imported name of a file comes from, with its name there. */
const importsOf = (path: string) => {
    const found = new Map<string, { path: string; name: string }>()
    for (const [, names, specifier] of read(path).matchAll(
        /import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g,
    )) {
        if (!specifier?.startsWith('.')) continue
        for (const part of names?.split(',') ?? []) {
            const [name, alias] = part
                .trim()
                .replace(/^type\s+/, '')
                .split(/\s+as\s+/)
            if (name) found.set(alias ?? name, { path: resolveModule(path, specifier), name })
        }
    }
    return found
}

/** A top-level declaration's text: from its line to the next top-level line. */
const declaration = (path: string, name: string) => {
    const source = read(path)
    const start = source.search(new RegExp(`^(export )?(const|function) ${name}\\b`, 'm'))
    if (start === -1) return
    const body = source.indexOf('\n', start) + 1
    const end = source.slice(body).search(/^(export|const|let|function|type|\/\/|\/\*)/m)
    return source.slice(start, end === -1 ? undefined : body + end)
}

type Flags = { readOnly: boolean; leavesPeek: boolean }

/** A command's flags, following factories (`createNote(0)`) and re-exports to their objects. */
const flagsOf = (path: string, name: string, depth = 0): Flags => {
    if (depth > 4) throw new Error(`Too deep resolving ${name}`)
    const text = declaration(path, name)
    if (text !== undefined) {
        if (/\breadOnly: true\b|\bleavesPeek: true\b/.test(text))
            return {
                readOnly: /\breadOnly: true\b/.test(text),
                leavesPeek: /\bleavesPeek: true\b/.test(text),
            }
        // A factory's product, built on the declaration's own line (`= createNote(0)`).
        const factory = /^[^\n=]*=\s*(\w+)\(/.exec(text)?.[1]
        if (factory && factory !== name) return flagsOf(path, factory, depth + 1)
        return { readOnly: false, leavesPeek: false }
    }
    const imported = importsOf(path).get(name)
    if (!imported) throw new Error(`Cannot find ${name} in ${path}`)
    return flagsOf(imported.path, imported.name, depth + 1)
}

/** The registry's commands: each name and the expression it's built from. */
const builtInCommands = () => {
    const index = 'src/editor/commands/index.ts'
    const source = read(index)
    const block = /const builtInCommands = \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
    return block
        .split('\n')
        .map((line) => line.trim().replace(/,$/, ''))
        .filter((line) => line && !line.startsWith('//'))
        .map((line) => {
            const [name, expression] = line.split(/:\s*/)
            const id = /^(\w+)/.exec(expression ?? name!)![1]!
            return { name: name!, flags: flagsOf(index, id) }
        })
}

test('every command is on exactly one of the peek lists, with its flag', () => {
    const lists = [...allowed, ...leaving, ...refused]
    assert.equal(new Set(lists).size, lists.length, 'a name is on two lists')
    const commands = builtInCommands()
    assert.ok(commands.length > 100)
    for (const { name, flags } of commands) {
        assert.ok(lists.includes(name), `${name} is on no list`)
        if (allowed.includes(name))
            assert.deepEqual(flags, { readOnly: true, leavesPeek: false }, `${name} is allowed`)
        else if (leaving.includes(name))
            assert.deepEqual(flags, { readOnly: false, leavesPeek: true }, `${name} leaves`)
        else assert.deepEqual(flags, { readOnly: false, leavesPeek: false }, `${name} is refused`)
    }
})

const sources = readdirSync(new URL('src/', root), { recursive: true, encoding: 'utf8' })
    .map((path) => `src/${path.replaceAll('\\', '/')}`)
    .filter((path) => /\.(ts|vue)$/.test(path))

/** Every module that runs commands; each goes through runCommand (§1.4.11's entry points). */
const entryPoints = [
    'src/editor/LevelEditor.vue',
    'src/editor/LevelEditorContextMenu.vue',
    'src/editor/commands/events/index.ts',
    'src/editor/contextMenu.ts',
    'src/editor/controls/gestures/recognizers/threeTap.ts',
    'src/editor/controls/gestures/recognizers/twoTap.ts',
    'src/editor/controls/keyboard.ts',
    'src/editor/controls/mouse.ts',
    'src/editor/elevation/ElevationEditor.vue',
    'src/editor/history/TimelineList.vue',
    'src/editor/levelInfo.ts',
    'src/editor/save/flow.ts',
    'src/editor/switch.ts',
    'src/editor/toolbar/LevelEditorToolbar.vue',
    'src/editor/workspace/properties/ViewProperties.vue',
]

test('every command entry point runs commands through runCommand', () => {
    const callers = sources.filter((path) => /\brunCommand\(/.test(read(path)))
    assert.deepEqual(
        callers.filter((path) => path !== 'src/editor/commands/runCommand.ts').sort(),
        [...entryPoints].sort(),
    )
    // The one place commands execute, and its gate.
    const gate = read('src/editor/commands/runCommand.ts')
    assert.match(gate, /if \(isPeeking\.value\) \{/)
    assert.match(gate, /if \(command\.leavesPeek\) leavePeek\(\)/)
    assert.match(gate, /else if \(!command\.readOnly\) \{\s*refuseWhilePeeking/)
})

/** Command folders holding more than one command, or named otherwise. */
const commandFolders: Record<string, string[]> = {
    scaleSelection: ['scaleBeat', 'scaleElevation', 'scaleWidth'],
}

/** The body of a file's `onPeekStart` listener. */
const peekStartBody = (path: string) => {
    const source = read(path)
    const start = source.search(/onPeekStart\(\(\) => \{/)
    assert.ok(start !== -1, `${path} registers onPeekStart`)
    return source.slice(start, source.indexOf('\n})', start))
}

/** ManagerList's handlers that edit, each refused while peeking. */
const managerEdits = [
    'startRename',
    'endRename',
    'reorder',
    'addEntry',
    'onNewFolder',
    'duplicateRow',
    'chooseFolder',
    'onBulkDelete',
    'onBulkFolder',
    'run',
    'runBulk',
]

const asyncModalGate = (source: string) => {
    assert.match(
        source,
        /const guard = createAsyncEditGuard\(\)[^]*?await showModal\([^]*?if \([^]*?!guard\.isCurrent\(\)\)[^]*?\breturn\b[^]*?\bpushState\(/,
    )
    assert.match(source, /finally \{\s*guard\.dispose\(\)/)
}

/** What each gate of the call-site list rests on, checked in the source. */
const gateChecks: Record<string, (path: string, source: string) => void> = {
    // The command's file: its command is refused (checked above by name).
    command: (path) => {
        const folder = /commands\/(\w+)\//.exec(path)?.[1] ?? ''
        const names = commandFolders[folder] ?? [folder]
        if (path === 'src/history/dynamicStages.ts')
            assert.match(read(path), /if \(isPeeking\.value\) \{\s*refuseWhilePeeking\(\)/)
        // A load notice's Choose Audio… reaches changeBgm without runCommand.
        else if (path === 'src/editor/commands/bgm/index.ts') {
            const body = declaration(path, 'changeBgm') ?? ''
            assert.match(body, /if \(isPeeking\.value\) \{\s*refuseWhilePeeking\(\)[^]*showModal\(/)
            asyncModalGate(body)
        }
        if (path !== 'src/history/dynamicStages.ts')
            for (const name of names)
                assert.ok(refused.includes(name), `${path}: ${name} is refused`)
    },
    // Tools are suspended: the tool in use while peeking is the view-only Select.
    tool: () => {
        assert.match(read('src/editor/tools/index.ts'), /isPeeking\.value\s*\? viewSelect/)
    },
    // Select's push is a move, which the view-only Select never starts.
    select: () => {
        const view = declaration('src/editor/tools/select.ts', 'viewSelect') ?? ''
        assert.match(view, /type: 'select'/)
        assert.doesNotMatch(view, /type: 'move'|resolveDrag/)
    },
    // replaceState while peeking changes only the peeked state's selection.
    selection: (_, source) => {
        assert.doesNotMatch(source, /\bpushState\(/)
    },
    // A peek cancels drags before it shows (onPeekStart in src/editor/peek.ts).
    drag: () => {
        const start = peekStartBody('src/editor/peek.ts')
        assert.match(start, /cancelMouseControls\(\)/)
        assert.match(start, /cancelTouchControls\(\)/)
        // Leaving switches the tool from view-only Select, which ends a drag.
        assert.match(
            read('src/editor/controls/index.ts'),
            /\[tool, state\],[^]*?cancelControls\(currentTool === previousTool\)/,
        )
    },
    // Panels and managers: disabled, and the writes they reach refuse while peeking.
    panel: (path) => {
        const guards: Record<string, string> = {
            'src/editor/sidebars/default/index.ts': 'src/editor/sidebars/default/index.ts',
            'src/editor/workspace/manager/folders.ts':
                'src/editor/workspace/manager/ManagerList.vue',
            'src/editor/workspace/manager/groups.ts':
                'src/editor/workspace/manager/ManagerList.vue',
            'src/editor/workspace/manager/stages.ts':
                'src/editor/workspace/manager/ManagerList.vue',
            // Opened from a manager's Properties (refused) or Manage Groups/Stages (refused).
            'src/editor/commands/manageGroups/manageGroups/groupProperties/GroupPropertiesModal.vue':
                'src/editor/workspace/manager/ManagerList.vue',
            'src/editor/commands/manageStages/manageStages/stageProperties/StagePropertiesModal.vue':
                'src/editor/workspace/manager/ManagerList.vue',
        }
        const guard = guards[path]
        assert.ok(guard, `${path} has no listed guard`)
        assert.match(read(guard), /refuseWhilePeeking\(\)/)
        if (guard !== 'src/editor/workspace/manager/ManagerList.vue') return
        // Each edit handler refuses; a drag to reorder doesn't start.
        for (const name of managerEdits)
            assert.match(declaration(guard, name) ?? '', /\brefused\(\)/, `${name} refuses`)
        assert.match(declaration(guard, 'onDragStart') ?? '', /if \(isPeeking\.value\) return/)
    },
    // Closed while peeking, or behind the overlay side by side.
    elevation: () => {
        assert.match(peekStartBody('src/editor/peek.ts'), /closeElevationForPeek\(\)/)
        // Side by side, its own drag or marquee ends.
        assert.match(peekStartBody('src/editor/elevation/ElevationEditor.vue'), /\bcancel\(\)/)
        assert.match(read('src/editor/elevation/ElevationEditor.vue'), /v-if="isPeeking"/)
    },
    // Level Info: shown read-only, and nothing is pushed while peeking.
    levelInfo: (path) => {
        asyncModalGate(declaration(path, 'properties') ?? '')
    },
}

test('direct pushState sites have inspected gates or Restore runtime coverage', () => {
    for (const [path, { gate }] of Object.entries(callSites)) {
        if (gate === 'restore') {
            // peek.test.ts covers Restore from a peek and a newer peek during its leave hook.
            assert.equal(path, 'src/history/peek.ts', 'Restore runtime coverage is for this writer')
            continue
        }
        const check = gateChecks[gate]
        assert.ok(check, `${gate} has no check`)
        check(path, read(path))
    }
})

test('the shared async modal gate refuses current and intervening peeks', () => {
    const source = declaration('src/editor/asyncEditGuard.ts', 'createAsyncEditGuard') ?? ''
    assert.match(source, /let current = !isPeeking\.value/)
    assert.match(source, /const invalidate = \(\) => \{\s*current = false/)
    assert.match(source, /watch\(\[liveState, isPeeking\], invalidate, \{ flush: 'sync' \}\)/)
    assert.match(source, /isCurrent: \(\) => current && !isPeeking\.value/)
})

test('paste refuses when a peek began while it waited', () => {
    const source = read('src/editor/tools/paste/index.ts')
    assert.equal(source.match(/if \(peekedMeanwhile\(\)\) return/g)?.length, 2)
})
