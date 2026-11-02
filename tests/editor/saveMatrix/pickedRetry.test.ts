import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorld, flow, settle } from './world'

const { FileError } = await import('../../../src/platform')

for (const command of ['saveAs', 'first', 'separate', 'missing', 'stored'] as const)
    for (const point of ['inspect', 'write'] as const)
        test(`${command}: Try Again after permission is denied during ${point === 'inspect' ? 'inspection' : 'writing'} keeps the picked file, options and identity`, async () => {
            const w = await createWorld({
                own: command === 'first' ? 'unbound' : command === 'missing' ? 'missing' : 'bound',
                ownDisk: command === 'separate' ? 'ahead' : 'base',
            })
            const original = await w.fileBytes('own.nxsp')
            const builds: {
                target: { kind: string; docId?: string }
                options: { history: boolean; bgm: boolean }
            }[] = []
            w.on('worker:buildSave', (_n, arg) => {
                builds.push(arg as (typeof builds)[number])
            })
            const handle = w.handle('fresh.nxsp')
            const read = w.mock.read
            const inspect = w.mock.inspect
            let denied = false
            let failed = false
            w.mock.read = (target) => {
                if (denied && target.kind === 'handle' && target.handle.name === handle.name)
                    return Promise.reject(new FileError('denied', 'Denied'))
                return read(target)
            }
            w.mock.inspect = (target, kind) => {
                if (denied && target.kind === 'handle' && target.handle.name === handle.name)
                    return Promise.reject(new FileError('denied', 'Denied'))
                return inspect(target, kind)
            }
            const permissions: string[] = []
            handle.requestPermission = () => {
                if (denied) permissions.push(handle.name)
                denied = false
                return Promise.resolve('granted')
            }
            const picked =
                point === 'inspect'
                    ? w.atPoint('picked', () => {
                          denied = true
                      })
                    : undefined
            w.mock.fault = (at, name) => {
                if (point !== 'write' || at !== 'checked' || name !== handle.name || failed) return
                failed = true
                denied = true
                throw new FileError('denied', 'Denied')
            }
            w.pick(handle.name)
            w.answers.saveDialog.push({
                action: 'save',
                fileName: handle.name,
                history: false,
                bgm: false,
            })
            w.answers.denied.push('tryAgain')
            w.answers.conflict.push('separate')
            w.answers.notFound.push('saveAs')
            if (command === 'saveAs') await flow.saveAs()
            else if (command === 'stored') await flow.saveToFile('session-other')
            else await flow.save()
            await picked
            await settle()
            assert.deepEqual(
                w.writes.map((write) => write.name),
                [handle.name],
            )
            assert.deepEqual(await w.fileBytes('own.nxsp'), original)
            assert.equal(w.openings.length, 1)
            assert.deepEqual(permissions, [handle.name])
            assert.equal(w.dialogs.filter((dialog) => dialog.kind === 'denied').length, 1)
            assert.ok(builds.length >= 2)
            assert.ok(builds.every((build) => build.target.kind === builds[0]!.target.kind))
            assert.ok(builds.every((build) => build.target.docId === builds[0]!.target.docId))
            assert.ok(
                builds.every(
                    (build) =>
                        build.options.history === builds[0]!.options.history &&
                        build.options.bgm === builds[0]!.options.bgm,
                ),
            )
            assert.equal(
                w.dialogs.some((dialog) => dialog.kind === 'denied' && dialog.lockHeld),
                false,
            )
            if (command !== 'stored') assert.equal(w.boundName(), handle.name)
        })
