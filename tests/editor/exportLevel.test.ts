import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { gzip, ungzip } from 'pako'
import * as tally from '../../src/analytics/tally'
// Export's picker path loads the Save core, which needs the stand-ins for the browser's modules.
import {
    exportByPicker,
    exportToTarget,
    type ExportContext,
    type ExportUi,
} from '../../src/editor/commands/exportLevel/flow'
import { clearExportMemory, exportMemory } from '../../src/editor/commands/exportLevel/memory'
import { setPlatformForTests } from '../../src/platform'
import { levelDataDiskState } from '../../src/platform/fingerprint'
import { createMockPlatform, type MockPlatform } from '../../src/platform/mock'
import { FileError } from '../../src/platform/types'
import { buildZip } from '../../src/zip'
import './saveMatrix/env'

const { setSaveUiForTests } = await import('./saveMatrix/stubs/dialogs')

const level = (n: number) => new Blob([gzip(JSON.stringify({ bgmOffset: 0, entities: [{ n }] }))])

const read = async (mock: MockPlatform, name: string) =>
    JSON.parse(
        new TextDecoder().decode(ungzip(new Uint8Array(await mock.files.get(name)!.arrayBuffer()))),
    ) as { entities: { n: number }[] }

type Asked = { dialog: string; args: unknown[] }

/** A UI that records each dialog and answers from a script. */
const scriptedUi = (answers: unknown[]) => {
    const asked: Asked[] = []
    const feedback: string[] = []
    const ask =
        (dialog: string) =>
        (...args: unknown[]) => {
            asked.push({ dialog, args })
            return Promise.resolve(answers.shift())
        }
    const ui = {
        conflict: ask('conflict'),
        notLevelData: ask('notLevelData'),
        unsupportedParts: ask('unsupportedParts'),
        notPutBack: ask('notPutBack'),
        notFound: ask('notFound'),
        denied: ask('denied'),
        failed: ask('failed'),
        exported: (name: string) => feedback.push(`exported:${name}`),
        downloadStarted: (name: string, size: number) => feedback.push(`download:${name}:${size}`),
    } as ExportUi
    return { ui, asked, feedback }
}

let mock: MockPlatform

/** What the Save core's own feedback said: the offer's download, or its failure. */
let saveFeedback: string[] = []

// Read through a call, so an assertion does not narrow it for later reads.
const remembered = () => exportMemory.target

beforeEach(() => {
    mock = createMockPlatform()
    setPlatformForTests(mock)
    clearExportMemory()
    saveFeedback = []
    setSaveUiForTests({
        saved: (shown: { kind: string; name: string; size: number }) =>
            saveFeedback.push(`${shown.kind}:${shown.name}:${shown.size}`),
        error: () => saveFeedback.push('error'),
    } as never)
})

afterEach(() => {
    setPlatformForTests(undefined)
})

const context = (ui: ExportUi, n = 1, extra: Partial<ExportContext> = {}): ExportContext => ({
    ui,
    build: () => level(n),
    suggestedName: 'Coconut.nsld',
    types: [{ description: 'Next SEKAI level data', extension: '.nsld' }],
    leave: () => undefined,
    ...extra,
})

/** An opened LevelData as Open remembers it: the target, not exported to yet. */
const openedTarget = async (name = 'LevelData') => {
    mock.writeFile(name, level(0))
    const handle = mock.createHandle(name)
    const target = {
        name,
        handle,
        disk: await levelDataDiskState(await handle.getFile()),
        exported: false,
    }
    exportMemory.target = target
    return target
}

test('Export to an unchanged target writes in place, asking permission first', async () => {
    const target = await openedTarget()
    const { ui, asked, feedback } = scriptedUi([])
    assert.equal(await exportToTarget(context(ui), target), 'done')
    assert.deepEqual(asked, [])
    assert.deepEqual(feedback, ['exported:LevelData'])
    assert.deepEqual(mock.calls, ['requestPermission:LevelData', 'write:LevelData'])
    assert.deepEqual((await read(mock, 'LevelData')).entities, [{ n: 1 }])
    assert.equal(exportMemory.target?.exported, true)
    assert.equal(
        exportMemory.target?.disk.fingerprint,
        (await levelDataDiskState(new File([mock.files.get('LevelData')!], 'x'))).fingerprint,
    )
})

test('a changed target meets the conflict dialog; Replace overwrites it and keeps nothing', async () => {
    const target = await openedTarget()
    mock.writeFile('LevelData', level(7))
    const { ui, asked, feedback } = scriptedUi(['replace'])
    assert.equal(await exportToTarget(context(ui), target), 'done')
    assert.equal(asked.length, 1)
    assert.equal(asked[0]?.dialog, 'conflict')
    // "…since you opened it here." before the first export, with the size and time on disk.
    const [name, disk, opened] = asked[0]!.args as [string, { size: number }, boolean]
    assert.equal(name, 'LevelData')
    assert.equal(disk.size, level(7).size)
    assert.equal(opened, true)
    assert.deepEqual((await read(mock, 'LevelData')).entities, [{ n: 1 }])
    assert.deepEqual([...mock.files.keys()], ['LevelData'])
    assert.deepEqual(feedback, ['exported:LevelData'])
})

test('after an export, the conflict dialog says "since your last export"', async () => {
    const target = await openedTarget()
    const { ui } = scriptedUi([])
    await exportToTarget(context(ui), target)
    mock.writeFile('LevelData', level(8))
    const second = scriptedUi([undefined])
    assert.equal(await exportToTarget(context(second.ui, 2), exportMemory.target!), 'cancelled')
    assert.equal(second.asked[0]?.args[2], false)
    // Cancel writes nothing.
    assert.deepEqual((await read(mock, 'LevelData')).entities, [{ n: 8 }])
})

test('a file changed again before Replace commits shows the dialog again', async () => {
    const target = await openedTarget()
    mock.writeFile('LevelData', level(7))
    const { ui, asked } = scriptedUi(['replace', undefined])
    let changes = 0
    mock.beforeCommit = (name) => {
        if (changes++ === 0) mock.writeFile(name, level(9))
    }
    assert.equal(await exportToTarget(context(ui), target), 'cancelled')
    assert.deepEqual(
        asked.map(({ dialog }) => dialog),
        ['conflict', 'conflict'],
    )
    assert.deepEqual((await read(mock, 'LevelData')).entities, [{ n: 9 }])
})

test('Choose Another… in the conflict dialog exports to the picked file, the new target', async () => {
    const target = await openedTarget()
    mock.writeFile('LevelData', level(7))
    mock.saveTargets.push({ kind: 'handle', handle: mock.createHandle('Other.nsld') })
    const { ui, feedback } = scriptedUi(['chooseAnother'])
    assert.equal(await exportToTarget(context(ui), target), 'done')
    assert.deepEqual((await read(mock, 'LevelData')).entities, [{ n: 7 }])
    assert.deepEqual((await read(mock, 'Other.nsld')).entities, [{ n: 1 }])
    assert.equal(exportMemory.target?.name, 'Other.nsld')
    assert.equal(exportMemory.target?.exported, true)
    assert.deepEqual(feedback, ['exported:Other.nsld'])
})

test('Export never writes over a target that is no longer level data', async () => {
    const target = await openedTarget()
    // A .nxsp (a ZIP) now in its place.
    const zip = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])])
    mock.writeFile('LevelData', zip)
    const { ui, asked } = scriptedUi([undefined])
    assert.equal(await exportToTarget(context(ui), target), 'cancelled')
    assert.deepEqual(asked, [{ dialog: 'notLevelData', args: ['LevelData'] }])
    assert.deepEqual(
        new Uint8Array(await mock.files.get('LevelData')!.arrayBuffer()),
        new Uint8Array(await zip.arrayBuffer()),
    )
})

test('a missing target offers Choose Another…', async () => {
    const target = await openedTarget()
    mock.files.delete('LevelData')
    const { ui, asked } = scriptedUi([undefined])
    assert.equal(await exportToTarget(context(ui), target), 'cancelled')
    assert.deepEqual(asked, [{ dialog: 'notFound', args: ['LevelData'] }])
    assert.equal(mock.files.has('LevelData'), false)
})

test('a dismissed picker goes back to the dialog; a picked file becomes the target', async () => {
    const { ui, feedback } = scriptedUi([])
    mock.saveTargets.push('cancel')
    assert.equal(await exportByPicker(context(ui, 1, { exportName: 'Coconut' })), 'back')
    assert.equal(remembered(), undefined)

    mock.saveTargets.push({ kind: 'handle', handle: mock.createHandle('Coconut.nsld') })
    assert.equal(await exportByPicker(context(ui, 1, { exportName: 'Coconut' })), 'done')
    assert.equal(remembered()?.name, 'Coconut.nsld')
    assert.equal(exportMemory.exportName, 'Coconut')
    assert.deepEqual(feedback, ['exported:Coconut.nsld'])
})

test('a browser without a save picker downloads, and reports its name and size', async () => {
    mock = createMockPlatform({ capabilities: { writeBack: false } })
    setPlatformForTests(mock)
    const { ui, feedback } = scriptedUi([])
    assert.equal(await exportByPicker(context(ui, 3)), 'done')
    assert.deepEqual(feedback, [`download:Coconut.nsld:${level(3).size}`])
    assert.equal(exportMemory.target, undefined)
})

test('a picked file this tab opened as a chart is refused and put back as it was read', async () => {
    const usc = new TextEncoder().encode('{"usc":{"objects":[],"offset":0},"version":2}')
    const handle = mock.createHandle('chart.usc')
    exportMemory.opened = { handle, levelData: false, partial: false, bytes: usc.buffer }
    // The file holds the chart; the pick empties it before the editor sees it.
    mock.writeFile('chart.usc', new Blob([usc]))
    mock.saveTargets.push({ kind: 'handle', handle: mock.createHandle('chart.usc') })
    const { ui, asked } = scriptedUi([undefined])
    assert.equal(await exportByPicker(context(ui)), 'cancelled')
    assert.deepEqual(asked, [{ dialog: 'notLevelData', args: ['chart.usc'] }])
    assert.deepEqual(new Uint8Array(await mock.files.get('chart.usc')!.arrayBuffer()), usc)
    assert.equal(exportMemory.target, undefined)
})

test('requestPermission is the first call on the gesture through exportToTarget', async () => {
    const target = await openedTarget()
    // The gesture's activation ends at the first await; a later call would see it expired.
    let active = true
    target.handle = mock.createHandle('LevelData', { activation: () => active })
    const { ui } = scriptedUi([])
    const exporting = exportToTarget(context(ui), target)
    active = false
    assert.equal(await exporting, 'done')
    assert.equal(mock.calls[0], 'requestPermission:LevelData:active')
})

test('a denied permission offers Try Again, which asks again and exports', async () => {
    const target = await openedTarget()
    const answers: PermissionState[] = ['denied', 'granted']
    target.handle = mock.createHandle('LevelData', { permission: () => answers.shift()! })
    let left = 0
    const { ui, asked, feedback } = scriptedUi(['tryAgain'])
    assert.equal(await exportToTarget(context(ui, 1, { leave: () => left++ }), target), 'done')
    assert.deepEqual(
        asked.map(({ dialog }) => dialog),
        ['denied'],
    )
    assert.equal(left, 1)
    assert.deepEqual(feedback, ['exported:LevelData'])
    assert.deepEqual((await read(mock, 'LevelData')).entities, [{ n: 1 }])
})

test('Cancel before the write starts writes nothing and shows nothing after', async () => {
    const target = await openedTarget()
    mock.writeFile('LevelData', level(7))
    const controller = new AbortController()
    let left = 0
    const { ui, asked, feedback } = scriptedUi([])
    const exporting = exportToTarget(
        context(ui, 1, { signal: controller.signal, leave: () => left++ }),
        target,
    )
    controller.abort()
    assert.equal(await exporting, 'cancelled')
    assert.deepEqual(asked, [])
    assert.deepEqual(feedback, [])
    assert.equal(left, 0)
    assert.deepEqual((await read(mock, 'LevelData')).entities, [{ n: 7 }])

    // Through the picker too.
    const second = new AbortController()
    mock.saveTargets.push({ kind: 'handle', handle: mock.createHandle('Other.nsld') })
    const picking = exportByPicker(context(ui, 1, { signal: second.signal }))
    second.abort()
    assert.equal(await picking, 'cancelled')
    assert.equal(mock.files.has('Other.nsld'), false)
})

test('the conflict dialog’s disk state and its level data check come from one read', async () => {
    const target = await openedTarget()
    // A .nxsp in its place, which a sync client shows as level data for one read.
    const zip = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])])
    mock.writeFile('LevelData', zip)
    const read = mock.read
    let flipped = false
    mock.read = (t) => {
        if (flipped) return read(t)
        flipped = true
        return Promise.resolve(new File([level(5)], 'LevelData'))
    }
    const { ui, asked } = scriptedUi(['replace', undefined])
    assert.equal(await exportToTarget(context(ui), target), 'cancelled')
    // The dialog shows what was read, so Replace's precondition is that, not the .nxsp.
    const disk = asked[0]?.args[1] as { fingerprint: string }
    assert.equal(
        disk.fingerprint,
        (await levelDataDiskState(new File([level(5)], 'x'))).fingerprint,
    )
    assert.deepEqual(
        asked.map(({ dialog }) => dialog),
        ['conflict', 'notLevelData'],
    )
    assert.deepEqual(
        new Uint8Array(await mock.files.get('LevelData')!.arrayBuffer()),
        new Uint8Array(await zip.arrayBuffer()),
    )
})

test('a target that cannot be read is reported as such, not as "not level data"', async () => {
    const target = await openedTarget()
    mock.writeFile('LevelData', level(7))
    mock.read = () => Promise.reject(new DOMException('Locked', 'NotReadableError'))
    const { ui, asked } = scriptedUi([undefined])
    assert.equal(await exportToTarget(context(ui), target), 'cancelled')
    assert.equal(asked[0]?.dialog, 'failed')
    const error = asked[0]?.args[1]
    assert.ok(error instanceof FileError)
    assert.equal(error.step, 'read')
})

test('a picked level whose import left parts out is refused and put back as it was read', async () => {
    const original = new Uint8Array(await level(4).arrayBuffer())
    const handle = mock.createHandle('LevelData')
    exportMemory.opened = { handle, levelData: true, partial: true, bytes: original.slice().buffer }
    // The file holds the level; the pick empties it.
    mock.writeFile('LevelData', new Blob([original]))
    mock.saveTargets.push({ kind: 'handle', handle: mock.createHandle('LevelData') })
    const { ui, asked } = scriptedUi([undefined])
    assert.equal(await exportByPicker(context(ui)), 'cancelled')
    assert.deepEqual(asked, [{ dialog: 'unsupportedParts', args: ['LevelData'] }])
    assert.deepEqual(new Uint8Array(await mock.files.get('LevelData')!.arrayBuffer()), original)
    assert.equal(exportMemory.target, undefined)
})

test('a picked chart that cannot be put back is reported, with its bytes to download', async () => {
    const usc = new TextEncoder().encode('{"usc":{"objects":[],"offset":0},"version":2}')
    exportMemory.opened = {
        handle: mock.createHandle('chart.usc'),
        levelData: false,
        partial: false,
        bytes: usc.buffer,
    }
    mock.writeFile('chart.usc', new Blob([usc]))
    // Writing it back is not allowed.
    const picked = mock.createHandle('chart.usc', { permission: () => 'denied' })
    mock.saveTargets.push({ kind: 'handle', handle: picked })
    const { ui, asked, feedback } = scriptedUi(['download'])
    assert.equal(await exportByPicker(context(ui)), 'cancelled')
    assert.deepEqual(asked, [{ dialog: 'notPutBack', args: ['chart.usc', true, true] }])
    assert.equal(mock.files.get('chart.usc')!.size, 0)
    assert.deepEqual(
        mock.downloads.map(({ kind, name }) => ({ kind, name })),
        [{ kind: 'recovery', name: 'chart.usc' }],
    )
    assert.deepEqual(new Uint8Array(await mock.downloads[0]!.blob.arrayBuffer()), usc)
    assert.deepEqual(feedback, [])
    assert.deepEqual(saveFeedback, [`download:chart.usc:${usc.byteLength}`])
})

/** A chart this tab opened from `chart.usc`, whose pick the picker emptied. */
const openedChart = () => {
    const usc = new TextEncoder().encode('{"usc":{"objects":[],"offset":0},"version":2}')
    exportMemory.opened = {
        handle: mock.createHandle('chart.usc'),
        levelData: false,
        partial: false,
        bytes: usc.buffer,
    }
    // The file holds the chart; the pick empties it.
    mock.writeFile('chart.usc', new Blob([usc]))
    return usc
}

test('a refused pick another program wrote since is left as it is, and said so', async () => {
    openedChart()
    // A sync client writes it between the pick and the check.
    const other = new Blob(['other content'])
    const inspect = mock.inspect
    mock.inspect = (target) => {
        mock.writeFile('chart.usc', other)
        mock.inspect = inspect
        return inspect(target)
    }
    mock.saveTargets.push({ kind: 'handle', handle: mock.createHandle('chart.usc') })
    const { ui, asked } = scriptedUi([undefined])
    assert.equal(await exportByPicker(context(ui)), 'cancelled')
    assert.deepEqual(asked, [{ dialog: 'notPutBack', args: ['chart.usc', false, true] }])
    assert.equal(await mock.files.get('chart.usc')!.text(), 'other content')
    assert.deepEqual(mock.calls, [])
})

test('a refused pick that is gone is not said to be emptied', async () => {
    openedChart()
    // Deleted after the pick, which emptied it.
    const inspect = mock.inspect
    mock.inspect = (target) => {
        mock.files.delete('chart.usc')
        mock.inspect = inspect
        return inspect(target)
    }
    mock.saveTargets.push({ kind: 'handle', handle: mock.createHandle('chart.usc') })
    const { ui, asked } = scriptedUi([undefined, undefined])
    assert.equal(await exportByPicker(context(ui)), 'cancelled')
    // The offer says the content is gone, then the file that cannot be found is said as well.
    assert.deepEqual(
        asked.map(({ dialog, args }) => [dialog, args[0], args[1]]),
        [
            ['notPutBack', 'chart.usc', false],
            ['failed', 'chart.usc', asked[1]?.args[1]],
        ],
    )
    assert.equal(mock.files.has('chart.usc'), false)
})

test('a failed download of the opened bytes is said to be a download failure', async () => {
    openedChart()
    const picked = mock.createHandle('chart.usc', { permission: () => 'denied' })
    mock.saveTargets.push({ kind: 'handle', handle: picked })
    const saveFile = mock.saveFile
    mock.saveFile = (req) =>
        req.kind === 'recovery' && !req.target
            ? Promise.reject(new TypeError('Failed to create a Blob URL'))
            : saveFile(req)
    const { ui, asked } = scriptedUi(['download'])
    assert.equal(await exportByPicker(context(ui)), 'cancelled')
    assert.deepEqual(
        asked.map(({ dialog, args }) => [dialog, args[0]]),
        [['notPutBack', 'chart.usc']],
    )
    // The Save core's own line, which the offer's download shares with the Save family.
    assert.deepEqual(saveFeedback, ['error'])
})

test('a cancel once the picker returned a file is written to its end and reported', async () => {
    const controller = new AbortController()
    let committed = 0
    mock.saveTargets.push({ kind: 'handle', handle: mock.createHandle('Other.nsld') })
    // The dialog is cancelled during the write, after the pick.
    mock.beforeCommit = () => controller.abort()
    const { ui, asked, feedback } = scriptedUi([])
    const ctx = context(ui, 1, { signal: controller.signal, committed: () => committed++ })
    assert.equal(await exportByPicker(ctx), 'done')
    assert.equal(committed, 1)
    assert.deepEqual(asked, [])
    assert.deepEqual(feedback, ['exported:Other.nsld'])
    assert.deepEqual((await read(mock, 'Other.nsld')).entities, [{ n: 1 }])
})

test('a cancel reaches a target’s write until its commit', async () => {
    const target = await openedTarget()
    const controller = new AbortController()
    mock.beforeCommit = () => controller.abort()
    const { ui, asked, feedback } = scriptedUi([])
    assert.equal(
        await exportToTarget(context(ui, 1, { signal: controller.signal }), target),
        'cancelled',
    )
    assert.deepEqual(asked, [])
    assert.deepEqual(feedback, [])
    assert.deepEqual((await read(mock, 'LevelData')).entities, [{ n: 0 }])
})

test('an AbortError with no cancel, and a failed picker, are shown as failures', async () => {
    const target = await openedTarget()
    mock.saveFile = () => Promise.reject(new DOMException('Blocked', 'AbortError'))
    const first = scriptedUi([undefined])
    const signal = new AbortController().signal
    assert.equal(await exportToTarget(context(first.ui, 1, { signal }), target), 'cancelled')
    assert.deepEqual(
        first.asked.map(({ dialog }) => dialog),
        ['failed'],
    )
    assert.equal((first.asked[0]?.args[1] as FileError).code, 'io')

    // A picker that fails is a failure too, never a dismissal.
    const second = scriptedUi([undefined])
    mock.pickSaveFile = () => Promise.reject(new FileError('io', 'The picker failed'))
    assert.equal(await exportByPicker(context(second.ui, 1, { signal })), 'cancelled')
    assert.deepEqual(
        second.asked.map(({ dialog }) => dialog),
        ['failed'],
    )
})

test('a failed picked write names the picked file, not the suggested one', async () => {
    mock.saveTargets.push({ kind: 'handle', handle: mock.createHandle('Typed.nsld') })
    mock.saveFile = () =>
        Promise.reject(new FileError('io', 'Disk error', undefined, undefined, 'Typed.nsld'))
    const { ui, asked } = scriptedUi([undefined])
    assert.equal(await exportByPicker(context(ui)), 'cancelled')
    assert.deepEqual(
        asked.map(({ dialog, args }) => [dialog, args[0]]),
        [['failed', 'Typed.nsld']],
    )
})

test('the conflict dialog has no modified time when the blob read does not say, never 1970', async () => {
    const target = await openedTarget()
    mock.writeFile('LevelData', level(7))
    let plain = true
    mock.read = () =>
        Promise.resolve(
            plain
                ? level(5)
                : new File([level(8)], 'LevelData', { lastModified: 1_700_000_000_000 }),
        )
    const first = scriptedUi([undefined])
    assert.equal(await exportToTarget(context(first.ui), target), 'cancelled')
    const shown = first.asked[0]?.args[1] as { size: number; lastModified?: number }
    assert.equal(shown.size, level(5).size)
    assert.equal(shown.lastModified, undefined)
    // A File carries its own time.
    plain = false
    const second = scriptedUi([undefined])
    assert.equal(await exportToTarget(context(second.ui), target), 'cancelled')
    const real = second.asked[0]?.args[1] as { lastModified?: number }
    assert.equal(real.lastModified, 1_700_000_000_000)
})

test('the mock empties a picked file at the pick and creates a new name empty, as Chromium does', async () => {
    mock.writeFile('Old.nsld', level(1))
    mock.saveTargets.push({ kind: 'handle', handle: mock.createHandle('Old.nsld') })
    mock.saveTargets.push({ kind: 'handle', handle: mock.createHandle('New.nsld') })
    for (const name of ['Old.nsld', 'New.nsld']) {
        const target = await mock.pickSaveFile!({
            suggestedName: name,
            picker: { id: 'levelData', types: [] },
        })
        assert.equal(target?.kind, 'handle')
        assert.equal(mock.files.get(name)?.size, 0)
    }
})

test('Export to a remembered target that now holds a project is refused and leaves it', async () => {
    const project = await buildZip([
        {
            name: 'project.json',
            method: 'deflate',
            data: new TextEncoder().encode('{"format":"nxsp","id":"P"}'),
        },
    ])
    mock.writeFile('LevelData', project)
    const handle = mock.createHandle('LevelData')
    // The remembered state is the project's own, so the changed-on-disk check passes.
    const target = {
        name: 'LevelData',
        handle,
        disk: await levelDataDiskState(await handle.getFile()),
        exported: false,
    }
    exportMemory.target = target
    const { ui, asked, feedback } = scriptedUi([undefined])
    assert.equal(await exportToTarget(context(ui), target), 'cancelled')
    assert.deepEqual(asked, [{ dialog: 'notLevelData', args: ['LevelData'] }])
    assert.deepEqual(feedback, [])
    assert.equal(
        mock.calls.some((call) => call.startsWith('write:')),
        false,
    )
    assert.equal(mock.files.get('LevelData')!.size, project.size)
})

test('an export that is written, and one that fails, are recorded for the usage statistics', async () => {
    tally.enable()
    try {
        const target = await openedTarget()
        const { ui } = scriptedUi([])
        assert.equal(await exportToTarget(context(ui), target), 'done')
        mock.saveFile = () =>
            Promise.reject(new FileError('no-space', 'Disk full', undefined, undefined, 'x.nsld'))
        const failing = scriptedUi([undefined])
        await exportToTarget(context(failing.ui), target)
        mock = createMockPlatform({ capabilities: { writeBack: false } })
        setPlatformForTests(mock)
        assert.equal(await exportByPicker(context(scriptedUi([]).ui, 3)), 'done')
        const events = tally
            .collect()
            .recorded.map(
                ({ name, data }) => ({ name, ...data }) as { name: string; took?: number },
            )
        assert.deepEqual(
            events.map(({ took: _took, ...rest }) => rest),
            [
                {
                    name: 'export',
                    format: 'levelData',
                    target: 'picker',
                    size: level(1).size,
                    outcome: 'done',
                },
                {
                    name: 'export',
                    format: 'levelData',
                    target: 'picker',
                    outcome: 'failed',
                    reason: 'no-space',
                },
                {
                    name: 'export',
                    format: 'levelData',
                    target: 'download',
                    size: level(3).size,
                    outcome: 'done',
                },
            ],
        )
    } finally {
        tally.disable()
    }
})
