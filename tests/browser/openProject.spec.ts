import { expect, test, type Page } from '@playwright/test'
import { captureEntryDescription } from '../../src/history/operations'
import { executePlan, planNxsp } from '../../src/local/nxsp'
import { fresh } from '../local/nxsp/chain'
import { crafted, jsonOf, setJson } from '../local/nxsp/craft'
import { damagedFile } from '../local/open/files'
import { closePage, installTestPlatform, waitForStartup } from './editorFixture'

// Opening a `.nxsp` (Part 1 §1.5.4): a new session stored at once and bound to the file, its
// history imported in the background, Undo where the file left off, and the partial opens that
// start a separate copy. Chromium's picker runs on OPFS handles through the platform override.

type Row = Record<string, unknown>

const memoryFiles = (page: Page) =>
    process.env.NSE_TEST_FILE_HANDLES === 'memory' ||
    page.context().browser()?.browserType().name() === 'webkit'

// WebKit's private profile cannot prepare OPFS files; only the picked handles are fakes.
const installMemoryFiles = () => {
    const prefix = 'nse.test.openFile.'
    window.nseTestHandles = new Map(
        Object.keys(localStorage)
            .filter((key) => key.startsWith(prefix))
            .map((key) => {
                const name = key.slice(prefix.length)
                const handle = {
                    kind: 'file',
                    name,
                    getFile: async () =>
                        new File([new Uint8Array(JSON.parse(localStorage.getItem(key)!))], name, {
                            lastModified: 0,
                        }),
                    queryPermission: async () => 'granted',
                    requestPermission: async () => 'granted',
                    isSameEntry: async (other: { name?: string }) => other.name === name,
                } as unknown as FileSystemFileHandle
                return [name, handle]
            }),
    )
}

/** A `.nxsp` of the shared test chain (four entries, a BGM and a cover), as bytes. */
const freshBytes = async () => {
    const file = await executePlan(planNxsp(fresh().input).plan, new Map())
    return [...new Uint8Array(await file.arrayBuffer())]
}

const start = async (page: Page, fileSystemAccess: boolean | 'opfs' = 'opfs', url = '/') => {
    await page.addInitScript(() => {
        localStorage.setItem('nse.test.storage', '{}')
        localStorage.setItem('sonolus-next-sekai-editor.showPreview', 'false')
        localStorage.setItem('sonolus-next-sekai-editor.showSidebar', 'false')
        // "Version X", never the update line's card, as the editor fixture seeds it.
        localStorage.setItem(
            'nse.test.version',
            JSON.stringify({ appVersion: '0.6.0', atTag: true }),
        )
        localStorage.setItem('sonolus-next-sekai-editor.lastAppVersion', JSON.stringify('0.6.0'))
    })
    if (memoryFiles(page)) await page.addInitScript(installMemoryFiles)
    await page.addInitScript(installTestPlatform, { fileSystemAccess })
    await page.goto(url)
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await waitForStartup(page)
}

/** Prepares picked bytes, with real OPFS except for the explicit memory handle fixture. */
const writeFile = async (page: Page, name: string, bytes: number[]) => {
    if (memoryFiles(page)) {
        expect(bytes.length, 'the cross-tab handle fixture stays small').toBeLessThan(256 * 1024)
        await page.evaluate(
            ({ name, bytes }) => {
                localStorage.setItem(`nse.test.openFile.${name}`, JSON.stringify(bytes))
            },
            { name, bytes },
        )
        await page.evaluate(installMemoryFiles)
        return
    }
    await page.evaluate(
        async ({ name, bytes }) => {
            const root = await navigator.storage.getDirectory()
            const handle = await root.getFileHandle(name, { create: true })
            const writable = await handle.createWritable()
            await writable.write(new Uint8Array(bytes))
            await writable.close()
        },
        { name, bytes },
    )
}

/** Opens the prepared file through the same command as a picker. */
const openFile = async (page: Page, name: string) => {
    if (memoryFiles(page)) {
        await page.evaluate(installMemoryFiles)
        await page.evaluate(async () => {
            const { platform, setPlatformForTests } =
                (await import('/src/platform/index.ts')) as typeof import('../../src/platform')
            setPlatformForTests({
                ...platform,
                pickFiles: async () => {
                    const picks = JSON.parse(
                        localStorage.getItem('nse.test.picks') ?? '[]',
                    ) as string[]
                    const name = picks.shift()
                    localStorage.setItem('nse.test.picks', JSON.stringify(picks))
                    const handle = name && window.nseTestHandles?.get(name)
                    if (!handle) return []
                    return [{ handle, file: await handle.getFile() }]
                },
            })
        })
    }
    await page.evaluate((name) => {
        localStorage.setItem('nse.test.picks', JSON.stringify([name]))
    }, name)
    await page.keyboard.press('o')
}

const rows = (page: Page, stores: string[]) =>
    page.evaluate(
        (stores) =>
            window.nseStorageTest!.worker.call('testRows', stores) as Promise<
                Record<string, { key: unknown; value: Row }[]>
            >,
        stores,
    )

const sessionOf = (page: Page) =>
    page.evaluate(async () => {
        const { session } =
            (await import('/src/history/session.ts')) as typeof import('../../src/history/session')
        return session.value
    })

const noteCount = (page: Page) =>
    page.evaluate(async () => {
        const { state } =
            (await import('/src/history/index.ts')) as typeof import('../../src/history')
        return [...state.value.store.slides.note.values()].flat().length
    })

/** The open's import ended: no session row is waiting for it. */
const imported = (page: Page) =>
    expect
        .poll(async () => {
            const { sessions } = await rows(page, ['sessions'])
            return sessions!.filter((row) => row.value.importPending === true).length
        })
        .toBe(0)

const notice = (page: Page) => page.locator('.notification, .notification-pill')

test('a .nxsp opens bound in a new session, with its history imported and Undo where it left off', async ({
    page,
}) => {
    await start(page)
    await writeFile(page, 'coconut.nxsp', await freshBytes())
    await openFile(page, 'coconut.nxsp')
    await expect(notice(page).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    await imported(page)

    const session = await sessionOf(page)
    expect(session.file?.name).toBe('coconut.nxsp')
    expect(session.copyOf).toBeUndefined()
    expect(session.docId).toBe('doc')
    const { chains, sessions, entries } = await rows(page, ['chains', 'sessions', 'entries'])
    const chain = chains!.find((row) => row.value.head === session.sessionId)!.value
    expect(chain.revision).toMatchObject({ n: 1 })
    expect(chain.file).toMatchObject({
        name: 'coconut.nxsp',
        event: 'opened',
        options: { history: true, bgm: true },
        entry: { sessionId: session.sessionId, seq: 4, count: 4, notKept: 0 },
    })
    // The handle has its own store (D24); a real OPFS handle never reaches IndexedDB under the
    // override (D16).
    expect((chain.file as Row).handle).toBeUndefined()
    const { handles } = await rows(page, ['handles'])
    expect(handles!.map((row) => row.value)).toEqual([
        {
            chainId: chain.chainId,
            role: 'file',
            name: 'coconut.nxsp',
            handle: { testHandle: 'coconut.nxsp' },
        },
    ])
    expect(chain.edited).toBeUndefined()
    expect(sessions!.find((row) => row.value.id === session.sessionId)!.value.origin).toBe('nxsp')
    const own = entries!
        .map((row) => row.value)
        .filter((row) => row.sessionId === session.sessionId)
    expect(own.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5])
    expect(own.slice(0, 4).map(captureEntryDescription)).toEqual(
        fresh().input.history!.entries.map(captureEntryDescription),
    )
    expect(captureEntryDescription(own[4])).toMatchObject({
        kind: 'continue',
        operation: {
            id: 'nse.origin',
            version: 1,
            data: { origin: 'import', source: { text: 'coconut.nxsp' } },
        },
    })

    // Undo continues where the file left off: the first state has one note fewer.
    const notes = await noteCount(page)
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+z')
    await expect.poll(() => noteCount(page)).toBe(notes - 1)
})

test('a file with an unknown entry opens as a separate copy with a new docId and no binding', async ({
    page,
}) => {
    await start(page)
    const file = await crafted((items) => {
        items.push({ name: 'video/clip.mp4', data: new Uint8Array([1, 2, 3]), method: 'store' })
    })
    await writeFile(page, 'coconut.nxsp', [...new Uint8Array(await file.arrayBuffer())])
    await openFile(page, 'coconut.nxsp')
    await expect(
        notice(page).filter({
            hasText: 'Made by a newer version of Next SEKAI Editor. Saving makes a separate file.',
        }),
    ).toBeVisible()
    await imported(page)
    const session = await sessionOf(page)
    expect(session.file).toBeUndefined()
    expect(session.copyOf).toEqual({ name: 'coconut.nxsp', bound: true })
    expect(session.docId).not.toBe('doc')
    const { chains } = await rows(page, ['chains'])
    const chain = chains!.find((row) => row.value.head === session.sessionId)!.value
    expect(chain.file).toBeUndefined()
    expect(chain.revision).toBeUndefined()
    expect(chain.partialImport).toBe(true)
    expect(chain.lineageId).toBe('lineage')
})

test('a level with a value this build does not know asks first; Cancel opens nothing', async ({
    page,
}) => {
    await start(page)
    const file = await crafted((items) => {
        const level = jsonOf(items, 'level.json')
        const entities = level.entities as { archetype: string; data: Row[] }[]
        const note = entities.find((entity) =>
            entity.data.some((field) => field.name === 'flick' || field.name === 'direction'),
        )
        const field = note?.data.find((each) => each.name === 'direction' || each.name === 'flick')
        if (!field) throw new Error('No choice field to change')
        field.value = 99
        setJson(items, 'level.json', level)
    })
    await writeFile(page, 'coconut.nxsp', [...new Uint8Array(await file.arrayBuffer())])
    const before = await sessionOf(page)
    await openFile(page, 'coconut.nxsp')
    const dialog = page.getByRole('dialog').filter({ hasText: 'Uses Newer Features' })
    await expect(dialog).toContainText('"coconut.nxsp" Uses Newer Features')
    await expect(dialog.getByRole('button', { name: 'Open a Copy' })).toBeFocused()
    // Past the dialog's 300 ms activation guard.
    await page.waitForTimeout(400)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    expect((await sessionOf(page)).sessionId).toBe(before.sessionId)

    await openFile(page, 'coconut.nxsp')
    await expect(dialog).toHaveCount(1)
    await page.waitForTimeout(400)
    await dialog.getByRole('button', { name: 'Open a Copy' }).click()
    await expect(
        notice(page).filter({ hasText: 'Made by a newer version of Next SEKAI Editor.' }),
    ).toBeVisible()
    const session = await sessionOf(page)
    expect(session.sessionId).not.toBe(before.sessionId)
    expect(session.file).toBeUndefined()
    expect(session.copyOf).toEqual({ name: 'coconut.nxsp', bound: true })
})

/** Bytes of a file whose damaged chunk only the background import finds. */
const damagedBytes = async () => {
    const { file } = await damagedFile()
    return [...new Uint8Array(await file.arrayBuffer())]
}

const chainOf = async (page: Page, sessionId: string) => {
    const { chains } = await rows(page, ['chains'])
    return chains!.find((row) => row.value.head === sessionId)!.value
}

/** The token stored for a chain's handle under the override (D24). */
const handleToken = async (page: Page, chainId: string, role: string) => {
    const { handles } = await rows(page, ['handles'])
    const row = handles!.find((each) => each.value.chainId === chainId && each.value.role === role)
    return (row?.value.handle as { testHandle: string } | undefined)?.testHandle
}

/** How many stored handles the storage worker has read since it started. */
const handleReads = (page: Page) =>
    page.evaluate(() => window.nseStorageTest!.worker.call('testHandleReads') as Promise<number>)

/** A chain's binding or Export target handle, read as a Save or an Export reads it. */
const storedHandleName = (page: Page, chainId: string, role: 'file' | 'exportTarget') =>
    page.evaluate(
        async ({ chainId, role }) => {
            const { handleOf } =
                (await import('/src/local/handles.ts')) as typeof import('../../src/local/handles')
            return (await handleOf(window.nseStorageTest!.worker, chainId, role))?.name
        },
        { chainId, role },
    )

const ownRows = async (page: Page, sessionId: string) => {
    const { entries } = await rows(page, ['entries'])
    return entries!.map((row) => row.value).filter((row) => row.sessionId === sessionId)
}

test('damage found by the import unlinks the session: a new docId, no binding, the notice', async ({
    page,
}) => {
    await start(page)
    await writeFile(page, 'coconut.nxsp', await damagedBytes())
    await openFile(page, 'coconut.nxsp')
    await expect(
        notice(page).filter({
            hasText: '"coconut.nxsp" has damaged history. Saving makes a separate file.',
        }),
    ).toBeVisible()
    await imported(page)
    const session = await sessionOf(page)
    expect(session.file).toBeUndefined()
    expect(session.copyOf).toEqual({ name: 'coconut.nxsp', bound: true })
    expect(session.docId).not.toBe('doc')
    const chain = await chainOf(page, session.sessionId)
    expect(chain.docId).toBe(session.docId)
    expect(chain.file).toBeUndefined()
    expect(chain.revision).toBeUndefined()
    expect(chain.badChunks).toBeTruthy()
    // The rows that need the bad chunk show damaged; the rest stay.
    expect((await ownRows(page, session.sessionId)).map((row) => row.kept)).toEqual([
        false,
        true,
        true,
        true,
        true,
    ])

    // After a reload the chain still names the bad chunk, and the rows still show damaged.
    await page.reload()
    await waitForStartup(page)
    const again = await chainOf(page, session.sessionId)
    expect(again.badChunks).toEqual(chain.badChunks)
    expect(again.file).toBeUndefined()
})

/** Slows the import, so a spec acts while it runs. */
const slowImport = (page: Page, ms: number) =>
    page.evaluate((ms) => {
        localStorage.setItem('nse.test.importDelay', String(ms))
    }, ms)

test('a reload mid-import resumes it from the bound handle', async ({ page }) => {
    await start(page)
    await writeFile(page, 'coconut.nxsp', await freshBytes())
    await slowImport(page, 1500)
    await openFile(page, 'coconut.nxsp')
    await expect(notice(page).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    const session = await sessionOf(page)
    const chain = await chainOf(page, session.sessionId)
    const token = (await handleToken(page, chain.chainId as string, 'file'))!
    await page.addInitScript(() => localStorage.removeItem('nse.test.importDelay'))
    // The next load reads the handle back as a fake one: a spec cannot hold a real OPFS handle.
    if (!memoryFiles(page))
        await page.addInitScript(
            ({ token, name }) => {
                localStorage.removeItem('nse.test.importDelay')
                const opfs = async () =>
                    (await navigator.storage.getDirectory()).getFileHandle(name)
                const handle = {
                    kind: 'file',
                    name,
                    getFile: async () => (await opfs()).getFile(),
                    queryPermission: () => Promise.resolve('granted'),
                    isSameEntry: (other: { name?: string }) => Promise.resolve(other.name === name),
                }
                window.nseTestHandles = new Map([
                    [token, handle as unknown as FileSystemFileHandle],
                ])
            },
            { token, name: 'coconut.nxsp' },
        )
    await page.reload()
    await waitForStartup(page)
    await imported(page)
    expect((await ownRows(page, session.sessionId)).map((row) => [row.seq, row.kept])).toEqual([
        [1, true],
        [2, true],
        [3, true],
        [4, true],
        [5, true],
    ])
})

test('a reload reads no stored handle at startup; a Save or an Export reads it after', async ({
    page,
}) => {
    await start(page)
    await writeFile(page, 'coconut.nxsp', await freshBytes())
    await openFile(page, 'coconut.nxsp')
    await expect(notice(page).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    await imported(page)
    const session = await sessionOf(page)
    const chain = await chainOf(page, session.sessionId)
    await page.reload()
    await waitForStartup(page)
    expect((await sessionOf(page)).sessionId).toBe(session.sessionId)
    // Startup, recovery and the idle resume check read none (D24).
    await page.waitForTimeout(500)
    expect(await handleReads(page)).toBe(0)
    expect(await storedHandleName(page, chain.chainId as string, 'file')).toBe('coconut.nxsp')
    expect(await handleReads(page)).toBe(1)
})

test('Export’s target keeps its handle across a reload, read when Export opens', async ({
    page,
}) => {
    await start(page)
    // This chart's level data, gzipped, opened from a file: the opened file is Export's target.
    const bytes = await page.evaluate(async () => {
        const { buildLevelData } =
            (await import('/src/editor/commands/exportLevel/build.ts')) as typeof import('../../src/editor/commands/exportLevel/build')
        return [...new Uint8Array(await new Response(buildLevelData()).arrayBuffer())]
    })
    await writeFile(page, 'LevelData', bytes)
    await openFile(page, 'LevelData')
    await expect(notice(page).filter({ hasText: 'Opened level' })).toBeVisible()
    const session = await sessionOf(page)
    await expect
        .poll(async () => {
            // The session's first write stores its chain, then the target with it.
            const { chains } = await rows(page, ['chains'])
            const chain = chains!.find((row) => row.value.head === session.sessionId)?.value
            return chain && handleToken(page, chain.chainId as string, 'exportTarget')
        })
        .toBe('LevelData')
    expect(((await chainOf(page, session.sessionId)).exportTarget as Row).handle).toBeUndefined()
    await page.reload()
    await waitForStartup(page)
    expect((await sessionOf(page)).sessionId).toBe(session.sessionId)
    expect(await handleReads(page)).toBe(0)
    await page.keyboard.press('Shift+P')
    await expect(page.getByRole('dialog').locator('[data-export-target-name]')).toHaveText(
        'LevelData (the file you opened)',
    )
    expect(await handleReads(page)).toBe(1)
})

test('a reload mid-import without a handle marks the rows that never arrived kept: false', async ({
    page,
}) => {
    await start(page, false)
    await slowImport(page, 1500)
    const bytes = await freshBytes()
    const choosing = page.waitForEvent('filechooser')
    await page.keyboard.press('o')
    await (
        await choosing
    ).setFiles({
        name: 'coconut.nxsp',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from(bytes),
    })
    await expect(notice(page).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    const session = await sessionOf(page)
    expect(session.file?.name).toBe('coconut.nxsp')
    await page.evaluate(() => {
        localStorage.removeItem('nse.test.importDelay')
    })
    await page.reload()
    await waitForStartup(page)
    await imported(page)
    const own = await ownRows(page, session.sessionId)
    // The head's row stays whole; at least the first state never arrived.
    expect(own.at(-1)?.kept).toBe(true)
    expect(own.some((row) => row.kept === false)).toBe(true)
    const chain = await chainOf(page, session.sessionId)
    expect((chain.file as Row).name).toBe('coconut.nxsp')
})

test('a Save waits for the import: whenImported resolves once the last batch commits', async ({
    page,
}) => {
    await start(page)
    await writeFile(page, 'coconut.nxsp', await freshBytes())
    await slowImport(page, 500)
    await openFile(page, 'coconut.nxsp')
    await expect(notice(page).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    const outcome = await page.evaluate(async () => {
        const { session } =
            (await import('/src/history/session.ts')) as typeof import('../../src/history/session')
        const { whenImported } =
            (await import('/src/local/open/importLoop.ts')) as typeof import('../../src/local/open/importLoop')
        const result = await whenImported(session.value.sessionId)
        const found = (await window.nseStorageTest!.worker.call('testRows', [
            'sessions',
        ])) as unknown as {
            sessions: { value: Record<string, unknown> }[]
        }
        return {
            result,
            pending: found.sessions.some(
                (row) =>
                    row.value.id === session.value.sessionId && row.value.importPending === true,
            ),
        }
    })
    expect(outcome).toEqual({ result: { kind: 'done' }, pending: false })
})

test('the same file opened in a second tab opens unbound, as a separate copy', async ({
    page,
    context,
}) => {
    await start(page)
    await writeFile(page, 'coconut.nxsp', await freshBytes())
    await openFile(page, 'coconut.nxsp')
    await expect(notice(page).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    await imported(page)
    const other = await context.newPage()
    await start(other)
    await openFile(other, 'coconut.nxsp')
    await expect(
        notice(other).filter({
            hasText: '"coconut.nxsp" is open in another tab or window, so this is a separate copy.',
        }),
    ).toBeVisible()
    const session = await sessionOf(other)
    expect(session.file).toBeUndefined()
    expect(session.copyOf).toEqual({ name: 'coconut.nxsp', bound: true })
    expect(session.docId).not.toBe('doc')
    // The first tab keeps its binding.
    expect((await sessionOf(page)).file?.name).toBe('coconut.nxsp')
})

/** An edit of the live state, as a tool's would be. */
const edit = (page: Page, initialLife: number) =>
    page.evaluate(async (initialLife) => {
        const { pushState, state } =
            (await import('/src/history/index.ts')) as typeof import('../../src/history')
        const { initialLife: operation } =
            (await import('/tests/helpers/historySteps.ts')) as typeof import('../helpers/historySteps')
        pushState(operation(state.value.initialLife, initialLife), { ...state.value, initialLife })
    }, initialLife)

test('opening the same file again: Reopen after editing, Restore after New in between', async ({
    page,
}) => {
    await start(page)
    await writeFile(page, 'coconut.nxsp', await freshBytes())
    await openFile(page, 'coconut.nxsp')
    await expect(notice(page).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    await imported(page)
    const first = await sessionOf(page)
    await edit(page, 777)
    await page.evaluate(() => window.nseFlushTest!.flusher.flush({ strict: true }))

    // The chain with unsaved changes is the session just left: only Reopen shows.
    await openFile(page, 'coconut.nxsp')
    await expect(notice(page).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Reopen/ })).toBeVisible()
    await imported(page)
    const second = await sessionOf(page)
    expect(second.sessionId).not.toBe(first.sessionId)

    // After New in between: the notice names the unsaved changes, with Restore Session.
    await page.keyboard.press('n')
    await expect(notice(page).filter({ hasText: 'New level' })).toBeVisible()
    await openFile(page, 'coconut.nxsp')
    await expect(
        notice(page).filter({
            hasText: 'Opened coconut.nxsp. You have unsaved changes to it from',
        }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Restore Session' }).click()
    await expect
        .poll(() =>
            page.evaluate(async () => {
                const { state } =
                    (await import('/src/history/index.ts')) as typeof import('../../src/history')
                return state.value.initialLife
            }),
        )
        .toBe(777)
    expect((await sessionOf(page)).file?.name).toBe('coconut.nxsp')
})

/** A file of the shared chain changed by `change`, as bytes. */
const changedBytes = async (change: Parameters<typeof crafted>[0]) => {
    const file = await crafted(change, await executePlan(planNxsp(fresh().input).plan, new Map()))
    return [...new Uint8Array(await file.arrayBuffer())]
}

test('a BGM recorded without its bytes opens bound with the BGM not loaded, and Choose Audio…', async ({
    page,
}) => {
    await start(page)
    const bytes = await changedBytes((items) => {
        const project = jsonOf(items, 'project.json')
        const bgm = { ...(project.bgm as Record<string, string>) }
        bgm.hash = (bgm.sha256 ?? '').slice(0, 32)
        delete bgm.sha256
        delete bgm.file
        project.bgm = bgm
        setJson(items, 'project.json', project)
        return items.filter((item) => !item.name.startsWith('bgm/'))
    })
    await writeFile(page, 'coconut.nxsp', bytes)
    await openFile(page, 'coconut.nxsp')
    await expect(notice(page).filter({ hasText: 'BGM not loaded' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Choose Audio…' })).toBeVisible()
    await imported(page)
    const session = await sessionOf(page)
    expect(session.file?.name).toBe('coconut.nxsp')
    const chain = await chainOf(page, session.sessionId)
    // Included, but not held: the next Save adds it once chosen (§1.5.4 step 5).
    expect((chain.file as Row).options).toEqual({ history: true, bgm: true })
})

test('a file whose title was edited outside opens with that title and "Changed outside the editor"', async ({
    page,
}) => {
    await start(page)
    const bytes = await changedBytes((items) => {
        const project = jsonOf(items, 'project.json')
        project.metadata.title = 'Edited Outside'
        setJson(items, 'project.json', project)
    })
    await writeFile(page, 'coconut.nxsp', bytes)
    await openFile(page, 'coconut.nxsp')
    await expect(notice(page).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    await imported(page)
    const title = await page.evaluate(async () => {
        const { state } =
            (await import('/src/history/index.ts')) as typeof import('../../src/history')
        return state.value.levelInfo.title
    })
    expect(title).toBe('Edited Outside')
    const session = await sessionOf(page)
    expect(session.file?.name).toBe('coconut.nxsp')
    const own = await ownRows(page, session.sessionId)
    expect(own.map((row) => row.kind)).toEqual(['init', 'edit', 'edit', 'save', 'edit', 'continue'])
    expect(own.slice(0, 4).map(captureEntryDescription)).toEqual(
        fresh().input.history!.entries.map(captureEntryDescription),
    )
    expect(captureEntryDescription(own[4])).toMatchObject({
        kind: 'edit',
        step: { kind: 'edit', operation: { id: 'nse.externalChange', version: 1, data: {} } },
    })
    expect(captureEntryDescription(own[5])).toMatchObject({
        kind: 'continue',
        operation: {
            id: 'nse.origin',
            version: 1,
            data: { origin: 'import', source: { text: 'coconut.nxsp' } },
        },
    })
    // Undo goes back to the history's head, with its own title.
    await page.keyboard.press('Control+z')
    await expect
        .poll(() =>
            page.evaluate(async () => {
                const { state } =
                    (await import('/src/history/index.ts')) as typeof import('../../src/history')
                return state.value.levelInfo.title
            }),
        )
        .not.toBe('Edited Outside')
})

test('opening a file whose session a dead tab left a journal for: Restore applies the journal first', async ({
    page,
    context,
}) => {
    await start(page)
    const other = await context.newPage()
    await start(other)
    await writeFile(page, 'coconut.nxsp', await freshBytes())
    await openFile(page, 'coconut.nxsp')
    await expect(notice(page).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    await imported(page)
    // Storing stalls, so the edit is the journal's alone, written on hide; then the tab dies.
    await page.evaluate(() => {
        window.nseFlushTest!.stall = true
    })
    await edit(page, 555)
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
        document.dispatchEvent(new Event('visibilitychange'))
    })
    await closePage(page, { runBeforeUnload: false })

    await openFile(other, 'coconut.nxsp')
    await expect(
        notice(other).filter({
            hasText: 'Opened coconut.nxsp. You have unsaved changes to it from',
        }),
    ).toBeVisible()
    await other.getByRole('button', { name: 'Restore Session' }).click()
    await expect
        .poll(() =>
            other.evaluate(async () => {
                const { state } =
                    (await import('/src/history/index.ts')) as typeof import('../../src/history')
                return state.value.initialLife
            }),
        )
        .toBe(555)
    expect((await sessionOf(other)).file?.name).toBe('coconut.nxsp')
})

test('a newer major version asks first, then opens only the level, unbound', async ({ page }) => {
    await start(page)
    const bytes = await changedBytes((items) => {
        const project = jsonOf(items, 'project.json')
        project.version = 2
        setJson(items, 'project.json', project)
    })
    await writeFile(page, 'coconut.nxsp', bytes)
    const before = await sessionOf(page)
    await openFile(page, 'coconut.nxsp')
    const dialog = page
        .getByRole('dialog')
        .filter({ hasText: 'Only the level can be opened from this file.' })
    await expect(dialog).toContainText('Made by a newer version of Next SEKAI Editor.')
    await expect(dialog.getByRole('button', { name: 'Open the Level' })).toBeFocused()
    await page.waitForTimeout(400)
    await dialog.getByRole('button', { name: 'Open the Level' }).click()
    await expect.poll(async () => (await sessionOf(page)).sessionId).not.toBe(before.sessionId)
    const session = await sessionOf(page)
    expect(session.file).toBeUndefined()
    expect(session.copyOf).toEqual({ name: 'coconut.nxsp', bound: true })
    const { entries } = await rows(page, ['entries'])
    // No history is read from a newer major version: the level alone.
    expect(
        entries!
            .map((row) => row.value)
            .filter((row) => row.sessionId === session.sessionId)
            .map((row) => row.kind),
    ).toEqual(['continue'])
})

test('a re-zipped file, every entry deflated, with a Japanese-named BGM and Thumbs.db, opens whole', async ({
    page,
    browserName,
}) => {
    await start(page)
    const bytes = await changedBytes((items) => {
        const project = jsonOf(items, 'project.json')
        const bgm = items.find((item) => item.name.startsWith('bgm/'))!
        bgm.name = 'bgm/曲.mp3'
        project.bgm.file = bgm.name
        setJson(items, 'project.json', project)
        for (const item of items) item.method = 'deflate'
        return [...items, { name: 'history/Thumbs.db', data: new Uint8Array([0]), method: 'store' }]
    })
    await writeFile(page, 'coconut.nxsp', bytes)
    await openFile(page, 'coconut.nxsp')
    await expect(notice(page).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    await imported(page)
    const session = await sessionOf(page)
    expect(session.file?.name).toBe('coconut.nxsp')
    const { media } = await rows(page, ['media'])
    // Private WebKit refuses media Blobs but keeps the imported chart and history.
    if (browserName === 'webkit') {
        expect(media).toHaveLength(0)
        expect(
            await page.evaluate(() => window.nseStorageTest!.status()?.mediaPending?.length),
        ).toBe(2)
    } else expect(media).toHaveLength(2)
    expect((await ownRows(page, session.sessionId)).every((row) => row.kept)).toBe(true)
})

test('in safe mode, where nothing is stored, a .nxsp opens its level alone', async ({ page }) => {
    await start(page, 'opfs', '/?safe')
    await writeFile(page, 'coconut.nxsp', await freshBytes())
    await openFile(page, 'coconut.nxsp')
    await expect(notice(page).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    const session = await sessionOf(page)
    expect(session.file).toBeUndefined()
    expect(session.sourceName).toBe('coconut.nxsp')
    expect(await noteCount(page)).toBeGreaterThan(0)
})
