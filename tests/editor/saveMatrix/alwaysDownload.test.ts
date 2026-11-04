import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as tally from '../../../src/analytics/tally'
import { ZipReader } from '../../../src/zip/reader'
import { createWorld, flow, settle } from './world'

const { FileError } = await import('../../../src/platform')

// Always Download after a failed write to a chosen file: Write to Chosen Files becomes Disabled and
// the same action runs again, as a download. A Save binds the download by name; Recent Sessions'
// Save… binds nothing and leaves the open session as it was.

/** The world's build as downloaded: its revision and what the build wrote. */
const projectOf = async (blob: Blob) => {
    const reader = await ZipReader.open(blob)
    const text = async (name: string) =>
        new TextDecoder().decode(await reader.read(reader.get(name)!, { maxSize: 1_000_000 }))
    const project = JSON.parse(await text('project.json')) as { revision: { id: string } }
    return { revision: project.revision.id, payload: await text('payload.txt') }
}

/** The `save` records of the usage statistics, with the facts these tests check. */
const saveRecords = () =>
    tally
        .collect()
        .recorded.filter(({ name }) => name === 'save')
        .map(({ data }) => ({
            action: data.action,
            history: data.history,
            bgm: data.bgm,
            target: data.target,
            outcome: data.outcome,
        }))

const withTally = async (run: () => Promise<void>) => {
    tally.enable()
    try {
        await run()
    } finally {
        tally.disable()
    }
}

// The world offers no History and holds no BGM, so the options differ from a record's defaults.
for (const [command, action, bgm] of [
    ['first', 'save', true],
    ['saveAs', 'saveAs', true],
    ['stored', 'saveToFile', false],
] as const)
    test(`${command}: a picked write that fails offers Always Download, which downloads the same save`, () =>
        withTally(async () => {
            const w = await createWorld({ own: command === 'first' ? 'unbound' : 'bound' })
            const handle = w.handle('fresh.nxsp')
            const built: unknown[] = []
            w.on('worker:buildSave', (_n, arg) => {
                built.push((arg as { target: { sessionId?: string } }).target.sessionId)
            })
            let failed = false
            w.mock.fault = (at, name) => {
                if (at !== 'checked' || name !== handle.name || failed) return
                failed = true
                throw new FileError('io', 'Error creating swap file')
            }
            w.pick(handle.name)
            w.answers.saveDialog.push({
                action: 'save',
                fileName: handle.name,
                history: true,
                bgm: false,
            })
            w.answers.failed.push('alwaysDownload')
            const before = (await w.storedChains()).find((chain) => chain.chainId === 'chain-own')
            if (command === 'saveAs') await flow.saveAs()
            else if (command === 'stored') await flow.saveToFile('session-other')
            else await flow.save()
            await settle()
            const failure = w.dialogs.find((dialog) => dialog.kind === 'failed')
            assert.deepEqual(failure?.args, [handle.name])
            assert.equal(failure?.download, true)
            assert.equal(w.filePicker.choice, 'disabled')
            assert.equal(w.openings.length, 1, 'no second picker')
            assert.deepEqual(
                w.mock.downloads.map((download) => [download.kind, download.name]),
                [['nxsp', handle.name]],
            )
            // A build of its own, after the one the failed write held.
            const project = await projectOf(w.mock.downloads[0]!.blob)
            assert.match(project.payload, /^built \d+ /)
            assert.notEqual(project.revision, 'rev-1')
            assert.equal((await w.mock.files.get(handle.name)?.size) ?? 0, 0)
            assert.deepEqual(saveRecords(), [
                { action, history: false, bgm, target: 'picker', outcome: 'failed' },
                { action, history: false, bgm, target: 'download', outcome: 'done' },
            ])
            const own = (await w.storedChains()).find((chain) => chain.chainId === 'chain-own')
            if (command === 'stored') {
                // Both builds are the selected session's.
                assert.deepEqual(built, ['session-other', 'session-other'])
                // Recent Sessions' Save… binds nothing: the open session keeps its binding.
                assert.deepEqual(own?.file, before?.file)
                return
            }
            const file = own?.file as { name?: string; event?: string } | undefined
            assert.equal(file?.name, handle.name)
            assert.equal(file?.event, 'downloaded')
            assert.equal(w.handleRows.has('chain-own:file'), false)
        }))

test('a write-back that fails offers Always Download, which downloads the changed work by name', async () => {
    const w = await createWorld({ own: 'bound', held: true })
    let failed = false
    w.mock.fault = (at, name) => {
        if (at !== 'checked' || name !== 'own.nxsp' || failed) return
        failed = true
        throw new FileError('io', 'Error creating swap file')
    }
    w.answers.failed.push('alwaysDownload')
    await flow.save()
    await settle()
    assert.equal(w.dialogs.find((dialog) => dialog.kind === 'failed')?.download, true)
    assert.equal(w.filePicker.choice, 'disabled')
    assert.deepEqual(
        w.mock.downloads.map((download) => [download.kind, download.name]),
        [['nxsp', 'own.nxsp']],
    )
    assert.match((await projectOf(w.mock.downloads[0]!.blob)).payload, /^built \d+ /)
    const own = (await w.storedChains()).find((chain) => chain.chainId === 'chain-own')
    assert.equal((own?.file as { event?: string } | undefined)?.event, 'downloaded')
})

test('a write-back refused twice, then Always Download, records each attempt', () =>
    withTally(async () => {
        const w = await createWorld({ own: 'bound', held: true })
        // Every write permission is refused: the write-back's and Try Again's.
        w.tune.writePermission = 'denied'
        w.answers.denied.push('tryAgain', 'alwaysDownload')
        await flow.save()
        await settle()
        const denied = w.dialogs.filter((dialog) => dialog.kind === 'denied')
        assert.deepEqual(
            denied.map((dialog) => dialog.download),
            [true, true],
        )
        assert.deepEqual(
            w.mock.downloads.map((download) => [download.kind, download.name]),
            [['nxsp', 'own.nxsp']],
        )
        assert.deepEqual(
            saveRecords().map(({ action, outcome }) => [action, outcome]),
            [
                ['save', 'failed'],
                ['save', 'failed'],
                ['downloadAgain', 'done'],
            ],
        )
    }))

for (const [code, offered] of [
    ['denied', true],
    ['read-only', true],
    ['no-space', false],
    ['not-local', false],
] as const)
    test(`a picked write that fails with ${code} ${offered ? 'offers' : 'does not offer'} Always Download`, async () => {
        const w = await createWorld({ own: 'unbound' })
        const handle = w.handle('fresh.nxsp')
        w.mock.fault = (at, name) => {
            if (at === 'checked' && name === handle.name) throw new FileError(code, 'Refused')
        }
        w.pick(handle.name)
        w.answers.saveDialog.push({
            action: 'save',
            fileName: handle.name,
            history: false,
            bgm: false,
        })
        await flow.save()
        await settle()
        const shown = w.dialogs.find((dialog) =>
            ['denied', 'readOnly', 'failed'].includes(dialog.kind),
        )
        assert.ok(shown, 'a failure dialog shows')
        assert.equal(!!shown.download, offered)
        assert.equal(w.filePicker.choice, 'auto')
    })

test('a build that fails before the picker opens does not offer Always Download', async () => {
    const w = await createWorld({ own: 'unbound' })
    w.behaviour.set('buildSave', () => 'throw')
    w.answers.saveDialog.push({
        action: 'save',
        fileName: 'fresh.nxsp',
        history: false,
        bgm: false,
    })
    await flow.save()
    await settle()
    const shown = w.dialogs.find((dialog) => dialog.kind === 'failed')
    assert.ok(shown, 'the failure shows')
    assert.equal(shown.download, undefined)
    assert.equal(w.openings.length, 0)
})

for (const [command, action, bgm] of [
    ['first', 'save', true],
    ['saveAs', 'saveAs', true],
    ['stored', 'saveToFile', false],
] as const)
    test(`${command}: a Try Again refused again still offers Always Download, and each attempt is recorded`, () =>
        withTally(async () => {
            const w = await createWorld({ own: command === 'first' ? 'unbound' : 'bound' })
            const handle = w.handle('fresh.nxsp')
            // Every write permission is refused: the first in the write, Try Again's before it.
            w.tune.writePermission = 'denied'
            w.pick(handle.name)
            w.answers.saveDialog.push({
                action: 'save',
                fileName: handle.name,
                history: false,
                bgm: false,
            })
            w.answers.denied.push('tryAgain', 'alwaysDownload')
            if (command === 'saveAs') await flow.saveAs()
            else if (command === 'stored') await flow.saveToFile('session-other')
            else await flow.save()
            await settle()
            const denied = w.dialogs.filter((dialog) => dialog.kind === 'denied')
            assert.equal(denied.length, 2)
            assert.deepEqual(
                denied.map((dialog) => dialog.download),
                [true, true],
            )
            assert.equal(w.filePicker.choice, 'disabled')
            assert.deepEqual(
                w.mock.downloads.map((download) => [download.kind, download.name]),
                [['nxsp', handle.name]],
            )
            assert.match((await projectOf(w.mock.downloads[0]!.blob)).payload, /^built \d+ /)
            const records = saveRecords()
            assert.deepEqual(
                records.map(({ target: _, ...record }) => record),
                [
                    { action, history: false, bgm, outcome: 'failed' },
                    { action, history: false, bgm, outcome: 'failed' },
                    { action, history: false, bgm, outcome: 'done' },
                ],
            )
            assert.equal(records.at(-1)!.target, 'download')
        }))

// Saves that follow a dialog: the not-found dialog's Save As… and the conflict's Save as a
// Separate File each record their own action, and Always Download's rerun records it again.
for (const [followUp, action, history] of [
    ['notFound', 'saveAs', false],
    ['separate', 'save', true],
] as const)
    test(`${followUp}: the usage statistics record the failed write and Always Download's download`, () =>
        withTally(async () => {
            const w = await createWorld(
                followUp === 'notFound' ? { own: 'missing' } : { own: 'bound', ownDisk: 'ahead' },
            )
            const handle = w.handle('fresh.nxsp')
            let failed = false
            w.mock.fault = (at, name) => {
                if (at !== 'checked' || name !== handle.name || failed) return
                failed = true
                throw new FileError('io', 'Error creating swap file')
            }
            w.pick(handle.name)
            if (followUp === 'notFound') {
                w.answers.notFound.push('saveAs')
                w.answers.saveDialog.push({
                    action: 'save',
                    fileName: handle.name,
                    history: true,
                    bgm: false,
                })
            } else w.answers.conflict.push('separate')
            w.answers.failed.push('alwaysDownload')
            await flow.save()
            await settle()
            assert.equal(w.mock.downloads.length, 1)
            assert.deepEqual(saveRecords().slice(1), [
                { action, history, bgm: true, target: 'picker', outcome: 'failed' },
                { action, history, bgm: true, target: 'download', outcome: 'done' },
            ])
        }))
