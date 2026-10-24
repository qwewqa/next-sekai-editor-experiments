import { expect, test, type Page } from '@playwright/test'
import { executePlan, planNxsp } from '../../src/local/nxsp'
import type { CallOptions } from '../../src/local/worker/rpc'
import type { StorageHandlers } from '../../src/local/worker/storage.worker'
import { fresh } from '../local/nxsp/chain'
import { damagedFile } from '../local/open/files'
import { installTestPlatform, waitForStartup } from './editorFixture'

type Row = Record<string, unknown>
declare global {
    interface Window {
        switchRace: {
            readId?: string
            fileReads?: number
            held: boolean
            released: boolean
            dropped: number
            done: boolean
            result?: unknown
            failure?: string
            release: (fail?: boolean) => void
            restore: () => void
        }
    }
}

const start = async (page: Page) => {
    await page.addInitScript(() => {
        localStorage.setItem('nse.test.storage', '{}')
        localStorage.setItem('sonolus-next-sekai-editor.showPreview', 'false')
        localStorage.setItem('sonolus-next-sekai-editor.showSidebar', 'false')
        localStorage.setItem(
            'nse.test.version',
            JSON.stringify({ appVersion: '0.6.0', atTag: true }),
        )
        localStorage.setItem('sonolus-next-sekai-editor.lastAppVersion', JSON.stringify('0.6.0'))
    })
    await page.addInitScript(installTestPlatform, { fileSystemAccess: 'opfs' as const })
    await page.goto('/')
    await waitForStartup(page)
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
}
const bytes = async () => [
    ...new Uint8Array(
        await (await executePlan(planNxsp(fresh().input).plan, new Map())).arrayBuffer(),
    ),
]
const write = (page: Page, content: number[], name = 'race.nxsp') =>
    page.evaluate(
        async ({ content, name }) => {
            const handle = await (
                await navigator.storage.getDirectory()
            ).getFileHandle(name, { create: true })
            const stream = await handle.createWritable()
            await stream.write(new Uint8Array(content))
            await stream.close()
        },
        { content, name },
    )
const launchOpen = (page: Page, name = 'race.nxsp') =>
    page.evaluate(async (name) => {
        const { openProject } =
            (await import('/src/editor/commands/open/project.ts')) as typeof import('../../src/editor/commands/open/project')
        const handle = await (await navigator.storage.getDirectory()).getFileHandle(name)
        void openProject(await handle.getFile(), handle).then(() => {
            if (window.switchRace) window.switchRace.done = true
        })
    }, name)
const rows = (page: Page, stores: string[]) =>
    page.evaluate(
        (stores) =>
            window.nseStorageTest!.worker.call('testRows', stores) as Promise<
                Record<string, { value: Row }[]>
            >,
        stores,
    )
const imported = (page: Page) =>
    expect
        .poll(
            async () =>
                (await rows(page, ['sessions'])).sessions!.filter(
                    (row) => row.value.importPending === true,
                ).length,
        )
        .toBe(0)
const snapshot = (page: Page) =>
    page.evaluate(async () => {
        const { session } =
            (await import('/src/history/session.ts')) as typeof import('../../src/history/session')
        const { liveState, canUndo, headStep } =
            (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
        const { readTabRecord } =
            (await import('/src/local/startup/tab.ts')) as typeof import('../../src/local/startup/tab')
        const { previousSession } =
            (await import('/src/local/startup/api.ts')) as typeof import('../../src/local/startup/api')
        const { exportMemory } =
            (await import('/src/editor/commands/exportLevel/memory.ts')) as typeof import('../../src/editor/commands/exportLevel/memory')
        return {
            session: session.value,
            life: liveState.value.initialLife,
            canUndo: canUndo.value,
            headStep: headStep.value,
            tab: readTabRecord(),
            previous: previousSession.value,
            partial: exportMemory.partial,
            target: exportMemory.target?.name,
            flusher: window.nseFlushTest!.flusher.session?.id,
        }
    })
const newChart = (page: Page) =>
    page.evaluate(async () => {
        const { resetState } =
            (await import('/src/history/index.ts')) as typeof import('../../src/history/index')
        resetState(false)
        await window.nseFlushTest!.flusher.outgoing
    })
const opened = async (page: Page, content?: number[]) => {
    await write(page, content ?? (await bytes()))
    await launchOpen(page)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(async () => (await snapshot(page)).session.file?.name).toBe('race.nxsp')
    await imported(page)
    return (await snapshot(page)).session.sessionId
}

// Hold a real RPC reply after its actual worker operation, never replace its data or mechanics.
const hold = (page: Page, method: 'readSnapshot' | 'openRead' | 'openStore' | 'readHandle') =>
    page.evaluate((method) => {
        const worker = window.nseStorageTest!.worker
        const original = worker.call.bind(worker)
        let taken = false
        window.switchRace = {
            held: false,
            released: false,
            dropped: 0,
            done: false,
            release() {},
            restore: () => {
                worker.call = original
            },
        }
        worker.call = async <K extends keyof StorageHandlers>(
            name: K,
            arg?: Parameters<StorageHandlers[K]>[0],
            options?: CallOptions & { current?: () => boolean },
        ): Promise<Awaited<ReturnType<StorageHandlers[K]>>> => {
            const result = await original(name, arg, options)
            if (name === 'openDrop') window.switchRace.dropped++
            if (
                name === 'openRead' &&
                result &&
                typeof result === 'object' &&
                'id' in result &&
                typeof result.id === 'string'
            )
                window.switchRace.readId = result.id
            if (name !== method || taken) return result
            taken = true
            window.switchRace.result = result
            window.switchRace.held = true
            await new Promise<void>((resolve, reject) => {
                window.switchRace.release = (fail) => {
                    window.switchRace.released = true
                    if (fail) reject(new Error('held worker failure'))
                    else resolve()
                }
            })
            return result
        }
    }, method)
const held = (page: Page) =>
    expect.poll(() => page.evaluate(() => window.switchRace.held)).toBe(true)
const release = (page: Page, fail = false) =>
    page.evaluate((fail) => window.switchRace.release(fail), fail)

test('Reopen forks when a different tab now binds the same physical file', async ({
    page,
    context,
}) => {
    await start(page)
    // Both visits start blank before a bound source exists; no startup continuation hides it.
    const other = await context.newPage()
    await start(other)
    const first = await opened(page)
    await newChart(page)
    await launchOpen(other)
    await expect.poll(async () => (await snapshot(other)).session.file?.name).toBe('race.nxsp')
    await imported(other)
    const second = (await snapshot(other)).session
    expect(second.sessionId).not.toBe(first)
    expect(
        await page.evaluate(async (first) => {
            const read = await window.nseStorageTest!.worker.call('readSession', first)
            return read.kind === 'open' && read.isHead
        }, first),
    ).toBe(true)
    await expect
        .poll(() =>
            page.evaluate(
                async (first) =>
                    (await navigator.locks.query()).held?.some(
                        (lock) => lock.name === `nse-session:${first}`,
                    ) ?? false,
                first,
            ),
        )
        .toBe(false)
    const result = await page.evaluate(async (first) => {
        const { restoreSession } =
            (await import('/src/local/startup/api.ts')) as typeof import('../../src/local/startup/api')
        return restoreSession(first)
    }, first)
    expect(result).toEqual({ opened: true, forked: true })
    const copy = await snapshot(page)
    expect(copy.session.file).toBeUndefined()
    expect(copy.session.docId).not.toBe(second.docId)
    expect(copy.session.copyOf).toEqual({ name: 'race.nxsp', bound: true })
    expect(copy.target).toBeUndefined()
    expect((await snapshot(other)).session.file?.name).toBe('race.nxsp')
})

for (const change of ['edit-undo', 'new', 'newer-restore'] as const) {
    test(`a held Restore cannot replace ${change} intent`, async ({ page }) => {
        await start(page)
        const target = await opened(page)
        await newChart(page)
        await hold(page, 'readSnapshot')
        await page.evaluate(async (target) => {
            const { restoreSession } =
                (await import('/src/local/startup/api.ts')) as typeof import('../../src/local/startup/api')
            void restoreSession(target).then((result) => {
                window.switchRace.done = true
                window.switchRace.result = result.opened
            })
        }, target)
        await held(page)
        if (change === 'new') await newChart(page)
        else if (change === 'newer-restore')
            await page.evaluate(async (target) => {
                const { restoreAsCopy } =
                    (await import('/src/local/startup/api.ts')) as typeof import('../../src/local/startup/api')
                await restoreAsCopy(target)
            }, target)
        else
            await page.evaluate(async () => {
                const { liveState, pushState, undoState } =
                    (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
                const { initialLife } =
                    (await import('/tests/helpers/historySteps.ts')) as typeof import('../helpers/historySteps')
                const before = liveState.value
                pushState(initialLife(before.initialLife, before.initialLife + 1), {
                    ...before,
                    initialLife: before.initialLife + 1,
                })
                undoState()
            })
        const expected = await snapshot(page)
        await release(page)
        await expect.poll(() => page.evaluate(() => window.switchRace.done)).toBe(true)
        expect(await snapshot(page)).toEqual(expected)
        expect(await page.evaluate(() => window.switchRace.result)).toBe(false)
    })
}

for (const boundary of ['openRead', 'openStore'] as const) {
    test(`cancelling at ${boundary} keeps current work and releases only the owned read`, async ({
        page,
    }) => {
        await start(page)
        await write(page, await bytes())
        await hold(page, boundary)
        await launchOpen(page)
        await held(page)
        const committed = (await rows(page, ['sessions'])).sessions!.filter(
            (row) => row.value.origin === 'nxsp',
        )
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await newChart(page)
        const expected = await snapshot(page)
        await release(page)
        await expect.poll(() => page.evaluate(() => window.switchRace.dropped)).toBeGreaterThan(0)
        await imported(page)
        expect(await snapshot(page)).toEqual(expected)
        const reader = await page.evaluate(async () => {
            const { createHistoryOperation } =
                (await import('/src/history/createHistoryOperation.ts')) as typeof import('../../src/history/createHistoryOperation')
            const id = window.switchRace.readId
            if (!id) throw new Error('no captured read')
            return window.nseStorageTest!.worker.call('openStore', {
                id,
                ids: {
                    sessionId: crypto.randomUUID(),
                    chainId: crypto.randomUUID(),
                    docId: crypto.randomUUID(),
                    lineageId: crypto.randomUUID(),
                },
                chain: {},
                operations: {
                    opened: createHistoryOperation({
                        id: 'nse.origin',
                        data: { origin: 'import' },
                    }),
                    changedOutside: createHistoryOperation({ id: 'nse.externalChange', data: {} }),
                },
                wall: Date.now(),
                appVersion: '0.6.0',
            })
        })
        expect(reader).toEqual({ kind: 'notOpened' })
        await expect
            .poll(() =>
                page.evaluate(
                    async (current) =>
                        (await navigator.locks.query()).held
                            ?.filter(
                                (lock) =>
                                    lock.name?.startsWith('nse-import:') ||
                                    (lock.name?.startsWith('nse-session:') &&
                                        lock.name !== `nse-session:${current}`),
                            )
                            .map((lock) => lock.name) ?? [],
                    expected.session.sessionId,
                ),
            )
            .toEqual([])
        const after = (await rows(page, ['sessions'])).sessions!
        if (boundary === 'openRead') expect(after).toHaveLength(0)
        else {
            expect(committed).toHaveLength(1)
            expect(after.some((row) => row.value.id === committed[0]!.value.id)).toBe(true)
        }
    })
}

test('unshown committed damage persists its partial safety state for a later Restore', async ({
    page,
}) => {
    await start(page)
    const { file } = await damagedFile()
    await write(page, [...new Uint8Array(await file.arrayBuffer())])
    await hold(page, 'openStore')
    await launchOpen(page)
    await held(page)
    const before = await snapshot(page)
    await page.keyboard.press('Escape')
    await release(page)
    await expect.poll(() => page.evaluate(() => window.switchRace.dropped)).toBeGreaterThan(0)
    await imported(page)
    expect(await snapshot(page)).toEqual(before)
    const chain = (await rows(page, ['chains'])).chains!.find(
        (row) => row.value.partialImport === true,
    )!.value
    expect(chain.file).toBeUndefined()
    const target = String(chain.head)
    await page.evaluate(async (target) => {
        const { restoreSession } =
            (await import('/src/local/startup/api.ts')) as typeof import('../../src/local/startup/api')
        await restoreSession(target)
    }, target)
    expect((await snapshot(page)).partial).toBe(true)
    expect((await snapshot(page)).session.file).toBeUndefined()
})

test('old read cleanup and batches cannot address a replacement worker read', async ({ page }) => {
    await start(page)
    await write(page, await bytes())
    const result = await page.evaluate(async () => {
        const worker = window.nseStorageTest!.worker
        const handle = await (await navigator.storage.getDirectory()).getFileHandle('race.nxsp')
        const file = await handle.getFile()
        const old = await worker.call('openRead', file)
        if (old.kind !== 'nxsp') throw new Error('not a project')
        const restarted = new Promise<void>((resolve) => {
            worker.onRestart(() => resolve())
        })
        await worker.call('testCrash')
        await restarted
        const next = await worker.call('openRead', file)
        if (next.kind !== 'nxsp') throw new Error('not a project')
        await worker.call('openDrop', old.id)
        const stale = await worker.call('openBatch', { id: old.id, n: 0 })
        const { createHistoryOperation } =
            (await import('/src/history/createHistoryOperation.ts')) as typeof import('../../src/history/createHistoryOperation')
        const stored = await worker.call('openStore', {
            id: next.id,
            ids: {
                sessionId: crypto.randomUUID(),
                chainId: crypto.randomUUID(),
                docId: crypto.randomUUID(),
                lineageId: crypto.randomUUID(),
            },
            chain: {
                file: { name: 'race.nxsp', event: 'opened' },
            },
            operations: {
                opened: createHistoryOperation({ id: 'nse.origin', data: { origin: 'import' } }),
                changedOutside: createHistoryOperation({ id: 'nse.externalChange', data: {} }),
            },
            wall: Date.now(),
            appVersion: '0.6.0',
        })
        if (stored.kind !== 'stored' || !stored.batches)
            throw new Error('replacement read did not store')
        const fresh = await worker.call('openBatch', { id: next.id, n: 0 })
        for (let n = 1; n < stored.batches; n++) await worker.call('openBatch', { id: next.id, n })
        const readback = await worker.call('readSession', String(stored.chain.head))
        await worker.call('openDrop', next.id)
        return {
            old: old.id,
            next: next.id,
            stale,
            fresh,
            readable: readback.kind === 'open' && readback.session.importPending !== true,
        }
    })
    expect(result.next).not.toBe(result.old)
    expect(result.stale).toEqual({ kind: 'notOpened' })
    expect(result.fresh).toEqual({ kind: 'done' })
    expect(result.readable).toBe(true)
})

for (const hook of ['edit', 'newer-request', 'throw'] as const) {
    test(`actual stored-session reset hooks keep newer view and coherent adoption: ${hook}`, async ({
        page,
    }) => {
        await start(page)
        const target = await opened(page)
        await newChart(page)
        const result = await page.evaluate(
            async ({ target, hook }) => {
                const { sessionContext, setSessionContext, restoreAsCopy } =
                    (await import('/src/local/startup/api.ts')) as typeof import('../../src/local/startup/api')
                const { onResetState } =
                    (await import('/src/history/resetHooks.ts')) as typeof import('../../src/history/resetHooks')
                const { createSwitchRequest } =
                    (await import('/src/editor/switchRequest.ts')) as typeof import('../../src/editor/switchRequest')
                const { liveState, pushState } =
                    (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
                const { initialLife } =
                    (await import('/tests/helpers/historySteps.ts')) as typeof import('../helpers/historySteps')
                const { session } =
                    (await import('/src/history/session.ts')) as typeof import('../../src/history/session')
                const { view } =
                    (await import('/src/editor/view.ts')) as typeof import('../../src/editor/view')
                const context = sessionContext()!
                setSessionContext(
                    {
                        ...context.open,
                        show: (shown) => context.open.show({ ...shown, view: { scroll: 7 } }),
                    },
                    context.recovery,
                )
                await restoreAsCopy(target)
                const ordinaryView = view.time
                const { resetState } =
                    (await import('/src/history/index.ts')) as typeof import('../../src/history')
                resetState(false)
                await window.nseFlushTest!.flusher.outgoing
                let inside: { session: string; flusher?: string; life: number } | undefined
                let armed = true
                let newer: ReturnType<typeof createSwitchRequest> | undefined
                onResetState(() => {
                    if (!armed) return
                    armed = false
                    inside = {
                        session: session.value.sessionId,
                        flusher: window.nseFlushTest!.flusher.session?.id,
                        life: liveState.value.initialLife,
                    }
                    view.time = 123
                    if (hook === 'throw') throw new Error('hook failed after adoption')
                    if (hook === 'newer-request') newer = createSwitchRequest()
                    else {
                        const head = liveState.value
                        pushState(initialLife(head.initialLife, head.initialLife + 1), {
                            ...head,
                            initialLife: head.initialLife + 1,
                        })
                    }
                })
                let failure: string | undefined
                try {
                    await restoreAsCopy(target)
                } catch (error) {
                    failure = String(error)
                }
                if (hook === 'edit') await window.nseFlushTest!.flusher.flush({ strict: true })
                const result = {
                    ordinaryView,
                    inside,
                    life: liveState.value.initialLife,
                    view: view.time,
                    session: session.value.sessionId,
                    flusher: window.nseFlushTest!.flusher.session?.id,
                    failure,
                }
                newer?.dispose()
                return result
            },
            { target, hook },
        )
        expect(result.ordinaryView).toBe(7)
        expect(result.view).toBe(123)
        expect(result.inside?.flusher).toBe(result.inside?.session)
        expect(result.inside?.session).toBe(result.session)
        expect(result.flusher).toBe(result.session)
        if (hook === 'edit') {
            expect(result.life).toBe(result.inside!.life + 1)
            const entries = (await rows(page, ['entries'])).entries!
            expect(
                entries.filter(
                    (row) => row.value.sessionId === result.session && row.value.kind === 'edit',
                ),
            ).toHaveLength(1)
        }
        if (hook === 'throw') expect(result.failure).toContain('hook failed after adoption')
        else expect(result.failure).toBeUndefined()
    })
}

for (const stale of [false, true]) {
    test(`a ${stale ? 'stale' : 'current'} delayed Open rejection ${stale ? 'stays quiet' : 'still reports its error'}`, async ({
        page,
    }) => {
        await start(page)
        await write(page, await bytes())
        await hold(page, 'openRead')
        await launchOpen(page)
        await held(page)
        if (stale) await newChart(page)
        await release(page, true)
        if (stale) {
            await expect(page.getByRole('dialog')).toHaveCount(0)
            await expect(page.getByText('held worker failure', { exact: true })).toHaveCount(0)
        } else {
            await expect(page.getByRole('dialog')).toContainText('held worker failure')
        }
    })
}

for (const navigate of [false, true]) {
    test(`decoded Open media ${navigate ? 'releases only its rejected waveform after navigation' : 'attaches after an unrelated note edit'}`, async ({
        page,
    }) => {
        await start(page)
        const result = await page.evaluate(async (navigate) => {
            const { attachOpenedBgm } =
                (await import('/src/local/open/project.ts')) as typeof import('../../src/local/open/project')
            const { resetState } =
                (await import('/src/history/index.ts')) as typeof import('../../src/history/index')
            const { session } =
                (await import('/src/history/session.ts')) as typeof import('../../src/history/session')
            const { liveState, replaceState, pushState } =
                (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
            const { initialLife } =
                (await import('/tests/helpers/historySteps.ts')) as typeof import('../helpers/historySteps')
            const { createWaveform } =
                (await import('/src/waveform.ts')) as typeof import('../../src/waveform')
            const hash = 'a'.repeat(32)
            replaceState({
                ...liveState.value,
                bgm: {
                    offset: 0,
                    meta: { hash, filename: 'fixture.wav', size: 1, type: 'audio/wav' },
                },
            })
            let release!: () => void
            const gate = new Promise<void>((resolve) => {
                release = resolve
            })
            const revoked: string[] = []
            const revoke = URL.revokeObjectURL
            URL.revokeObjectURL = (url) => {
                revoked.push(url)
                revoke.call(URL, url)
            }
            const buffer = new AudioBuffer({ length: 441, sampleRate: 44100, numberOfChannels: 1 })
            let own: string[] = []
            const task = attachOpenedBgm(
                new Blob([new Uint8Array([1])]),
                hash,
                async () => {
                    await gate
                    const waveform = await createWaveform(buffer, 'volume')
                    own = waveform?.images ?? []
                    return { offset: 0, buffer, waveform }
                },
                session.value.sessionId,
            )
            if (navigate) resetState(false)
            else {
                const head = liveState.value
                pushState(initialLife(head.initialLife, head.initialLife + 1), {
                    ...head,
                    initialLife: head.initialLife + 1,
                })
            }
            const other = await createWaveform(buffer, 'volume')
            release()
            await task
            URL.revokeObjectURL = revoke
            return {
                own,
                other: other?.images ?? [],
                revoked,
                attached: liveState.value.bgm.buffer === buffer,
            }
        }, navigate)
        expect(result.own.length).toBeGreaterThan(0)
        expect(result.other.length).toBeGreaterThan(0)
        expect(result.attached).toBe(!navigate)
        for (const url of result.own) expect(result.revoked.includes(url)).toBe(navigate)
        for (const url of result.other) expect(result.revoked).not.toContain(url)
    })
}

test('Open Other captures authority before its first lazy flow import', async ({ page }) => {
    await start(page)
    await opened(page)
    expect(
        await page.evaluate(() =>
            performance
                .getEntriesByType('resource')
                .some((entry) => new URL(entry.name).pathname === '/src/editor/save/flow.ts'),
        ),
        'fixture must exercise the first lazy flow import',
    ).toBe(false)
    let releaseRoute: (() => void) | undefined
    await page.route('**/src/editor/save/flow.ts*', async (route) => {
        await new Promise<void>((resolve) => {
            releaseRoute = resolve
        })
        await route.continue()
    })
    await page.evaluate(async () => {
        const { rememberHandle } =
            (await import('/src/editor/save/env.ts')) as typeof import('../../src/editor/save/env')
        const handle = await (await navigator.storage.getDirectory()).getFileHandle('race.nxsp')
        const getFile = handle.getFile.bind(handle)
        window.switchRace = {
            held: false,
            released: false,
            dropped: 0,
            done: false,
            release() {},
            restore() {},
        }
        handle.getFile = async () => {
            window.switchRace.fileReads = (window.switchRace.fileReads ?? 0) + 1
            return getFile()
        }
        rememberHandle(window.nseFlushTest!.flusher.session!.chainId, handle)
        const { fileActions } =
            (await import('/src/editor/file/actions.ts')) as typeof import('../../src/editor/file/actions')
        fileActions.openOtherVersion?.()
    })
    await expect.poll(() => !!releaseRoute).toBe(true)
    await page.evaluate(async () => {
        const { liveState, pushState, undoState } =
            (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
        const { initialLife } =
            (await import('/tests/helpers/historySteps.ts')) as typeof import('../helpers/historySteps')
        const state = liveState.value
        pushState(initialLife(state.initialLife, state.initialLife + 1), {
            ...state,
            initialLife: state.initialLife + 1,
        })
        undoState()
    })
    const expected = await snapshot(page)
    expect(expected.session.file?.name).toBe('race.nxsp')
    releaseRoute!()
    // The first import continuation and its cached-handle await precede this real worker barrier.
    await page.evaluate(async () => {
        await import('/src/editor/save/flow.ts')
        await window.nseStorageTest!.worker.call('testGet', 'switch-barrier')
    })
    expect(await page.evaluate(() => window.switchRace.fileReads ?? 0)).toBe(0)
    expect(await snapshot(page)).toEqual(expected)
    await expect(page.getByRole('dialog')).toHaveCount(0)
})

for (const boundary of ['readHandle', 'getFile'] as const) {
    test(`Open Other cannot acquire fresh authority after a held ${boundary}`, async ({ page }) => {
        await start(page)
        const originalSession = await opened(page)
        if (boundary === 'readHandle') await hold(page, 'readHandle')
        await page.evaluate(async (boundary) => {
            const { openOtherVersion } =
                (await import('/src/editor/save/flow.ts')) as typeof import('../../src/editor/save/flow')
            const { forgetHandle, rememberHandle } =
                (await import('/src/editor/save/env.ts')) as typeof import('../../src/editor/save/env')
            const flusher = window.nseFlushTest!.flusher
            const chainId = flusher.session!.chainId
            forgetHandle(chainId)
            if (boundary === 'getFile') {
                const handle = await (
                    await navigator.storage.getDirectory()
                ).getFileHandle('race.nxsp')
                const getFile = handle.getFile.bind(handle)
                window.switchRace = {
                    held: false,
                    released: false,
                    dropped: 0,
                    done: false,
                    release() {},
                    restore() {},
                }
                handle.getFile = async () => {
                    const file = await getFile()
                    window.switchRace.held = true
                    await new Promise<void>((resolve) => {
                        window.switchRace.release = () => {
                            window.switchRace.released = true
                            resolve()
                        }
                    })
                    return file
                }
                window.switchRace.restore = () => {
                    handle.getFile = getFile
                }
                rememberHandle(chainId, handle)
            }
            void openOtherVersion().then(() => {
                window.switchRace.done = true
            })
        }, boundary)
        await held(page)
        await newChart(page)
        const expected = await snapshot(page)
        await release(page)
        await expect.poll(() => page.evaluate(() => window.switchRace.done)).toBe(true)
        expect(await snapshot(page)).toEqual(expected)
        await expect(page.getByRole('dialog')).toHaveCount(0)
        if (boundary === 'getFile') {
            const restoredSession = await page.evaluate(async (target) => {
                window.switchRace.restore()
                const { restoreSession } =
                    (await import('/src/local/startup/api.ts')) as typeof import('../../src/local/startup/api')
                const { openOtherVersion } =
                    (await import('/src/editor/save/flow.ts')) as typeof import('../../src/editor/save/flow')
                const { session } =
                    (await import('/src/history/session.ts')) as typeof import('../../src/history/session')
                await restoreSession(target)
                const restoredSession = session.value.sessionId
                await openOtherVersion()
                return restoredSession
            }, originalSession)
            await imported(page)
            const current = await snapshot(page)
            expect(current.session.sessionId).not.toBe(restoredSession)
            expect(current.session.file?.name).toBe('race.nxsp')
        }
    })
}
