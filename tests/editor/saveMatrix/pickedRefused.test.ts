import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorld, flow, settle } from './world'

const { FileError } = await import('../../../src/platform')

// A platform that refuses to read the picked file, or to read and write it: the pick still
// receives the output, or the output is downloaded once instead.
for (const command of ['saveAs', 'first', 'separate', 'missing', 'stored'] as const)
    for (const point of ['read', 'write'] as const)
        test(`${command}: a refused ${point === 'read' ? 'read of the picked file still writes it' : 'read and write of the picked file downloads the output once'}`, async () => {
            const w = await createWorld({
                own: command === 'first' ? 'unbound' : command === 'missing' ? 'missing' : 'bound',
                ownDisk: command === 'separate' ? 'ahead' : 'base',
            })
            const original = await w.fileBytes('own.nxsp')
            const handle = w.handle('fresh.nxsp')
            const ours = (target: { kind: string; handle?: FileSystemFileHandle }) =>
                target.kind === 'handle' && target.handle?.name === handle.name
            const read = w.mock.read
            const inspect = w.mock.inspect
            w.mock.read = (target) =>
                ours(target) ? Promise.reject(new FileError('denied', 'Denied')) : read(target)
            w.mock.inspect = (target, kind) =>
                ours(target)
                    ? Promise.reject(new FileError('denied', 'Denied'))
                    : inspect(target, kind)
            let refused = false
            w.mock.fault = (at, name) => {
                if (point !== 'write' || at !== 'checked' || name !== handle.name || refused) return
                refused = true
                throw new FileError('denied', 'Denied')
            }
            w.pick(handle.name)
            w.answers.saveDialog.push({
                action: 'save',
                fileName: handle.name,
                history: false,
                bgm: false,
            })
            w.answers.conflict.push('separate')
            w.answers.notFound.push('saveAs')
            if (command === 'saveAs') await flow.saveAs()
            else if (command === 'stored') await flow.saveToFile('session-other')
            else await flow.save()
            await settle()
            assert.deepEqual(await w.fileBytes('own.nxsp'), original)
            assert.equal(w.openings.length, 1)
            assert.deepEqual(
                w.dialogs
                    .map((dialog) => dialog.kind)
                    .filter((kind) => kind !== 'saved' && kind !== 'saveDialog'),
                command === 'separate' ? ['conflict'] : command === 'missing' ? ['notFound'] : [],
            )
            assert.deepEqual(
                w.dialogs.filter((dialog) => dialog.kind === 'saved').map((dialog) => dialog.args),
                [[handle.name]],
            )
            if (point === 'read') {
                assert.deepEqual(
                    w.writes.map((write) => write.name),
                    [handle.name],
                )
                assert.equal(w.mock.downloads.length, 0)
            } else {
                assert.equal(w.writes.length, 0)
                assert.deepEqual(
                    w.mock.downloads.map((download) => [download.kind, download.name]),
                    [['nxsp', handle.name]],
                )
                assert.equal((await w.mock.files.get(handle.name)?.size) ?? 0, 0)
            }
            if (command === 'stored') return
            const own = (await w.storedChains()).find((chain) => chain.chainId === 'chain-own')
            const file = own?.file as { name?: string; event?: string } | undefined
            assert.equal(file?.name, handle.name)
            assert.equal(file?.event, point === 'read' ? 'saved' : 'downloaded')
            // A download never binds the handle it could not write.
            assert.equal(w.handleRows.has('chain-own:file'), point === 'read')
        })

// A write that closed but could not be read back: saved, with no disk state to check the file by.
for (const command of ['saveAs', 'stored'] as const)
    test(`${command}: a Save after a write that could not be read back never writes over a file unchecked`, async () => {
        const w = await createWorld({ own: 'bound', ownDisk: 'base' })
        const handle = w.handle('fresh.nxsp')
        const saveFile = w.mock.saveFile
        w.mock.saveFile = async (req) => {
            const result = await saveFile(req)
            if (result.status !== 'saved' || !req.picked) return result
            const unverified = { ...result }
            delete unverified.disk
            return unverified
        }
        w.pick(handle.name)
        w.answers.saveDialog.push({
            action: 'save',
            fileName: handle.name,
            history: true,
            bgm: true,
        })
        if (command === 'saveAs') await flow.saveAs()
        else await flow.saveToFile('session-other')
        await settle()
        const own = async () =>
            (await w.storedChains()).find((chain) => chain.chainId === 'chain-own')?.file as
                { name?: string; disk?: unknown } | undefined
        if (command === 'saveAs') {
            assert.equal((await own())?.name, handle.name)
            assert.equal((await own())?.disk, undefined)
        } else {
            // Recent Sessions' Save binds nothing.
            assert.equal((await own())?.name, 'own.nxsp')
        }
        // Save: after Save As, the picker opens at the file; after Recent Sessions' Save, the
        // session's own file is written back as before.
        w.pick(handle.name)
        await flow.save()
        await settle()
        assert.equal(
            w.dialogs.some((dialog) => dialog.kind === 'conflict' || dialog.kind === 'denied'),
            false,
        )
        assert.equal(w.openings.length, command === 'saveAs' ? 2 : 1)
        assert.deepEqual(
            w.writes.map((write) => write.name),
            command === 'saveAs' ? [handle.name, handle.name] : [handle.name, 'own.nxsp'],
        )
    })
