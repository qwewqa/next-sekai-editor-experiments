import { expect, test } from '@playwright/test'
import { edit, notice, pressSave, queuePicks, start, submitSave } from './saveFlows'

test('Export Video streams into the project file and revokes its binding', async ({ page }) => {
    await start(page)
    await edit(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    await queuePicks(page, ['coconut.nxsp'])
    const result = await page.evaluate(async () => {
        const { pickVideo } = await import('/src/editor/save/videoPick.ts')
        const { pickUi } = await import('/src/editor/save/flow.ts')
        const { environment, quickBinding } = await import('/src/editor/save/binding.ts')
        const { muxPickedVideo } = await import('/tests/helpers/muxPickedVideo.ts')
        const picked = await pickVideo({
            name: 'clip.webm',
            type: { description: 'WebM', extension: '.webm' },
            ui: pickUi,
        })
        if (picked.kind !== 'accepted') throw new Error(picked.kind)
        const binding = quickBinding(environment()!).file
        const locks = (await navigator.locks.query()).held?.map((lock) => lock.name)
        const video = await muxPickedVideo('webm', false, picked.pick.handle)
        return {
            binding,
            locks,
            size: video?.size,
            fileSize: (await picked.pick.handle.getFile()).size,
        }
    })
    expect(result.binding).toBeUndefined()
    expect(result.locks).not.toContain('nse-bind')
    expect(result.size).toBeGreaterThan(0)
    expect(result.fileSize).toBe(result.size)
})

test('a streamed pick refuses a changed file at commit and keeps the other bytes', async ({
    page,
}) => {
    await start(page)
    const result = await page.evaluate(async () => {
        const { pickVideo } = await import('/src/editor/save/videoPick.ts')
        const { pickUi } = await import('/src/editor/save/flow.ts')
        const { openPickedTarget } = await import('/src/editor/exportVideo/worker/target.ts')
        const picked = await pickVideo({
            name: 'clip.mp4',
            type: { description: 'MP4', extension: '.mp4' },
            ui: pickUi,
        })
        if (picked.kind !== 'accepted') throw new Error(picked.kind)
        const target = await openPickedTarget(picked.pick)
        await target.write(new Uint8Array([1, 2, 3]), 0)
        const other = await picked.pick.handle.createWritable()
        await other.write('other writer')
        await other.close()
        let code: unknown
        try {
            await target.close()
        } catch (error) {
            code = (error as { code: string }).code
        }
        return { code, text: await (await picked.pick.handle.getFile()).text() }
    })
    expect(result).toEqual({ code: 'conflict', text: 'other writer' })
})

test('cancelling a streamed pick removes only its unchanged empty file', async ({ page }) => {
    await start(page)
    expect(
        await page.evaluate(async () => {
            const { pickVideo } = await import('/src/editor/save/videoPick.ts')
            const { pickUi } = await import('/src/editor/save/flow.ts')
            const { openPickedTarget } = await import('/src/editor/exportVideo/worker/target.ts')
            const picked = await pickVideo({
                name: 'clip.mp4',
                type: { description: 'MP4', extension: '.mp4' },
                ui: pickUi,
            })
            if (picked.kind !== 'accepted') throw new Error(picked.kind)
            const target = await openPickedTarget(picked.pick)
            await target.write(new Uint8Array([1, 2]), 0)
            await target.abort()
            try {
                await picked.pick.handle.getFile()
                return 'exists'
            } catch (error) {
                return (error as DOMException).name
            }
        }),
    ).toBe('NotFoundError')
})

for (const cancel of [false, true])
    test(`a worker ${cancel ? 'cancels' : 'finishes'} positional writes to a staged video`, async ({
        page,
    }) => {
        await start(page)
        const result = await page.evaluate(async (cancel) => {
            const { platform } = await import('/src/platform/index.ts')
            const output = platform.videoOutput!
            const stage = await output.stage('worker', 'webm')
            const worker = new Worker('/tests/browser/videoOutputWorker.ts', { type: 'module' })
            try {
                await new Promise<void>((resolve, reject) => {
                    worker.onmessage = ({ data }) =>
                        data.ok ? resolve() : reject(new Error(data.error))
                    worker.onerror = (event) => reject(new Error(event.message))
                    worker.postMessage({ handle: stage.handle, cancel })
                })
            } finally {
                worker.terminate()
            }
            const bytes = [...new Uint8Array(await (await output.file('worker')).arrayBuffer())]
            await output.remove('worker')
            const dir = await (
                await navigator.storage.getDirectory()
            ).getDirectoryHandle('export-video')
            const names: string[] = []
            for await (const name of dir.keys()) names.push(name)
            return {
                bytes,
                names,
                locks: (await navigator.locks.query()).held?.map((lock) => lock.name),
            }
        }, cancel)
        expect(result.bytes).toEqual([1, 8, 9, 4])
        expect(result.names).toEqual([])
        expect(result.locks).not.toContain('nse-export-video:worker')
    })

test('download and share keep a staged video until Ready ends and retention expires', async ({
    page,
}) => {
    await start(page)
    await page.clock.install()
    await page.evaluate(async () => {
        const { platform } = await import('/src/platform/index.ts')
        const staged = await platform.videoOutput!.stage('ready', 'mp4')
        const stream = await staged.handle.createWritable()
        await stream.write('video bytes')
        await stream.close()
        Object.assign(window, { endVideoReady: staged.endReady })
    })
    for (let attempt = 0; attempt < 2; attempt++) {
        const download = page.waitForEvent('download')
        await page.evaluate(async () => {
            const { platform } = await import('/src/platform/index.ts')
            const output = platform.videoOutput!
            await output.deliver(await output.file('ready'), 'clip.mp4', 'download')
        })
        expect((await download).suggestedFilename()).toBe('clip.mp4')
        await page.clock.runFor(10 * 60_000 + 1)
        expect(
            await page.evaluate(async () => {
                const { platform } = await import('/src/platform/index.ts')
                await platform.videoOutput!.sweep()
                return (await platform.videoOutput!.file('ready')).text()
            }),
        ).toBe('video bytes')
    }
    expect(
        await page.evaluate(async () => {
            const { platform } = await import('/src/platform/index.ts')
            const output = platform.videoOutput!
            let type = ''
            Object.defineProperty(navigator, 'share', {
                configurable: true,
                value: async (data: ShareData) => {
                    type = data.files![0]!.type
                    throw new DOMException('Dismissed', 'AbortError')
                },
            })
            const status = await output.deliver(await output.file('ready'), 'clip.mp4', 'share')
            await (window as unknown as { endVideoReady(): Promise<void> }).endVideoReady()
            await output.sweep()
            const dir = await (
                await navigator.storage.getDirectory()
            ).getDirectoryHandle('export-video')
            const names: string[] = []
            for await (const name of dir.keys()) names.push(name)
            return { status, type, names }
        }),
    ).toEqual({ status: 'cancelled', type: 'video/mp4', names: ['ready.mp4'] })
    await page.clock.runFor(10 * 60_000 + 1)
    await expect
        .poll(() =>
            page.evaluate(async () => {
                const dir = await (
                    await navigator.storage.getDirectory()
                ).getDirectoryHandle('export-video')
                const names: string[] = []
                for await (const name of dir.keys()) names.push(name)
                return names
            }),
        )
        .toEqual([])
})

test('startup sweeps an orphan video before pressure cleanup and skips a held file', async ({
    page,
}) => {
    await start(page, { override: { privateSuspected: false } })
    await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory()
        const dir = await root.getDirectoryHandle('export-video', { create: true })
        await dir.getFileHandle('orphan.mp4', { create: true })
        await root.getFileHandle('project-media', { create: true })
    })
    await page.addInitScript(() => {
        Object.assign(window, { videoPressureChecks: [] as boolean[] })
        navigator.storage.estimate = () => Promise.resolve({ usage: 900, quota: 1000 })
        const post = Worker.prototype.postMessage
        Worker.prototype.postMessage = function (...args: unknown[]) {
            if ((args[0] as { method?: string }).method !== 'removeCachedMedia')
                return Reflect.apply(post, this, args)
            void (async () => {
                const dir = await (
                    await navigator.storage.getDirectory()
                ).getDirectoryHandle('export-video')
                let orphan = false
                for await (const name of dir.keys()) if (name === 'orphan.mp4') orphan = true
                ;(window as unknown as { videoPressureChecks: boolean[] }).videoPressureChecks.push(
                    orphan,
                )
                Reflect.apply(post, this, args)
            })()
        }
    })
    await page.reload()
    await expect
        .poll(() =>
            page.evaluate(
                () => (window as unknown as { videoPressureChecks: boolean[] }).videoPressureChecks,
            ),
        )
        .toEqual([false])
    expect(
        await page.evaluate(async () => {
            const { platform } = await import('/src/platform/index.ts')
            const active = await platform.videoOutput!.stage('active', 'webm')
            await platform.videoOutput!.sweep()
            const size = (await active.handle.getFile()).size
            await active.endReady()
            const root = await navigator.storage.getDirectory()
            return { size, media: (await root.getFileHandle('project-media')).name }
        }),
    ).toEqual({ size: 0, media: 'project-media' })
})

test('a sweep retries a failed deletion of a video left by a closed page', async ({
    page,
    context,
}) => {
    await start(page)
    await page.evaluate(async () => {
        const { platform } = await import('/src/platform/index.ts')
        await platform.videoOutput!.stage('closed', 'mp4')
    })
    const other = await context.newPage()
    await other.addInitScript(() => {
        const persist = navigator.storage.persist.bind(navigator.storage)
        Object.assign(window, {
            videoMaintenanceDone: new Promise<void>((resolve) => {
                // The startup sweep finishes before persist() runs. Keep the first page open until then.
                navigator.storage.persist = () => {
                    resolve()
                    return persist()
                }
            }),
        })
    })
    await start(other)
    await other.evaluate(
        () => (window as unknown as { videoMaintenanceDone: Promise<void> }).videoMaintenanceDone,
    )
    await page.close()
    // Closing a page can finish before the browser releases its Web Locks.
    await other.evaluate(() => navigator.locks.request('nse-export-video:closed', () => undefined))
    const result = await other.evaluate(async () => {
        const { platform } = await import('/src/platform/index.ts')
        const output = platform.videoOutput!
        const dir = await (
            await navigator.storage.getDirectory()
        ).getDirectoryHandle('export-video')
        const original = FileSystemDirectoryHandle.prototype.removeEntry
        let attempts = 0
        FileSystemDirectoryHandle.prototype.removeEntry = function (name, options) {
            if (this.name === 'export-video' && name === 'closed.mp4' && ++attempts === 1)
                return Promise.reject(new DOMException('Removal failed', 'UnknownError'))
            return original.call(this, name, options)
        }
        try {
            let failed = false
            try {
                await output.sweep()
            } catch {
                failed = true
            }
            const remaining = (await dir.getFileHandle('closed.mp4')).name
            const held = (await navigator.locks.query()).held?.map((lock) => lock.name)
            await output.sweep()
            const names: string[] = []
            for await (const name of dir.keys()) names.push(name)
            return { failed, remaining, held, names, attempts }
        } finally {
            FileSystemDirectoryHandle.prototype.removeEntry = original
        }
    })
    expect(result.failed).toBe(true)
    expect(result.remaining).toBe('closed.mp4')
    expect(result.held).not.toContain('nse-export-video:closed')
    expect(result.names).toEqual([])
    expect(result.attempts).toBe(2)
})
