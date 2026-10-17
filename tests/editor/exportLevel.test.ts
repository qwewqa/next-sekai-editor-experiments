import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { gzip, ungzip } from 'pako'
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
        notFound: ask('notFound'),
        denied: ask('denied'),
        failed: ask('failed'),
        exported: (name: string) => feedback.push(`exported:${name}`),
        downloadStarted: (name: string, size: number) => feedback.push(`download:${name}:${size}`),
    } as ExportUi
    return { ui, asked, feedback }
}

let mock: MockPlatform

beforeEach(() => {
    mock = createMockPlatform()
    setPlatformForTests(mock)
    clearExportMemory()
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
    assert.equal(exportMemory.target, undefined)

    mock.saveTargets.push({ kind: 'handle', handle: mock.createHandle('Coconut.nsld') })
    assert.equal(await exportByPicker(context(ui, 1, { exportName: 'Coconut' })), 'done')
    assert.equal(exportMemory.target?.name, 'Coconut.nsld')
    assert.equal(exportMemory.exportName, 'Coconut')
    assert.deepEqual(feedback, ['exported:Coconut.nsld'])
})

test('a download reports its name and size', async () => {
    const { ui, feedback } = scriptedUi([])
    mock.saveTargets.push('download')
    assert.equal(await exportByPicker(context(ui, 3)), 'done')
    assert.deepEqual(feedback, [`download:Coconut.nsld:${level(3).size}`])
    assert.equal(exportMemory.target, undefined)
})

test('a picked file this tab opened as a chart is refused and put back as it was read', async () => {
    const usc = new TextEncoder().encode('{"usc":{"objects":[],"offset":0},"version":2}')
    const handle = mock.createHandle('chart.usc')
    exportMemory.opened = { handle, levelData: false, bytes: usc.buffer }
    // The picker emptied it before the editor saw it (D5).
    mock.writeFile('chart.usc', new Blob([]))
    mock.saveTargets.push({ kind: 'handle', handle: mock.createHandle('chart.usc') })
    const { ui, asked } = scriptedUi([undefined])
    assert.equal(await exportByPicker(context(ui)), 'cancelled')
    assert.deepEqual(asked, [{ dialog: 'notLevelData', args: ['chart.usc'] }])
    assert.deepEqual(new Uint8Array(await mock.files.get('chart.usc')!.arrayBuffer()), usc)
    assert.equal(exportMemory.target, undefined)
})
