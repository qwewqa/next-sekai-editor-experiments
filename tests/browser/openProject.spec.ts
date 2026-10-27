import { expect, test, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { captureEntryDescription } from '../../src/history/operations'
import { executePlan, planNxsp } from '../../src/local/nxsp'
import { BGM_MAX_MINUTES } from '../../src/utils/bgmLimit'
import { buildZip } from '../../src/zip'
import { fresh } from '../local/nxsp/chain'
import { crafted, jsonOf, setJson, type Item } from '../local/nxsp/craft'
import { damagedFile } from '../local/open/files'
import { confirmNew, confirmWhenReady } from './confirmWhenReady'
import { closePage, installTestPlatform, waitForStartup } from './editorFixture'
import { openHistory, timeline } from './historyJourney'
import { en, said } from './messages'
import { holdImport } from './saveFlows'
import { pickWithClickInWebKit, skipWhereTheEditorCannotStart } from './webkitSupport'

// A WebKit build without OffscreenCanvas (Playwright's on Windows) cannot start the editor.
skipWhereTheEditorCannotStart()
pickWithClickInWebKit()

// Opening a `.nxsp`: a new session stored at once and bound to the file, its
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
        localStorage.setItem('sonolus-next-sekai-editor.firstVisitShown', '1')
        localStorage.setItem('sonolus-next-sekai-editor.agreement', '{"terms":999,"privacy":999}')
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
    // A confirmation: no severity glyph.
    await expect(notice(page).locator('svg[data-severity]')).toHaveCount(0)
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
        entry: { sessionId: session.sessionId, seq: 4, count: 4, notKept: 0 },
    })
    // The handle has its own store; a real OPFS handle never reaches IndexedDB under the
    // override.
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
            hasText:
                'This file was created by a newer version of Next SEKAI Editor. Saving will create a separate file.',
        }),
    ).toBeVisible()
    await expect(notice(page).locator('svg[data-severity]')).toHaveAttribute(
        'data-severity',
        'warning',
    )
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
    await expect(dialog).toContainText('“coconut.nxsp” Uses Newer Features')
    await expect(dialog.getByRole('button', { name: 'Open a Copy' })).toBeFocused()
    await confirmWhenReady(dialog.getByRole('button', { name: 'Cancel' }), dialog)
    await expect(dialog).toHaveCount(0)
    expect((await sessionOf(page)).sessionId).toBe(before.sessionId)

    await openFile(page, 'coconut.nxsp')
    await expect(dialog).toHaveCount(1)
    await confirmWhenReady(dialog.getByRole('button', { name: 'Open a Copy' }), dialog)
    await expect(
        notice(page).filter({
            hasText: 'This file was created by a newer version of Next SEKAI Editor.',
        }),
    ).toBeVisible()
    await expect(notice(page).locator('svg[data-severity]')).toHaveAttribute(
        'data-severity',
        'warning',
    )
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

/** The token stored for a chain's handle under the override. */
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
            const read = await handleOf(window.nseStorageTest!.worker, chainId, role)
            return read.storedRead === 'value' ? read.storedValue?.name : 'failed'
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
            hasText: 'The history in coconut.nxsp is damaged. Saving will create a separate file.',
        }),
    ).toBeVisible()
    await expect(notice(page).locator('svg[data-severity]')).toHaveAttribute(
        'data-severity',
        'warning',
    )
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
    // History reads the stored marks: the row says damaged, never "not kept".
    await openHistory(page)
    const flags = timeline(page).locator('[data-history-flag]')
    await expect(flags).toHaveCount(1)
    await expect(flags).toContainText('damaged')
    await expect(timeline(page)).not.toContainText('not kept')
})

test('damage the import finds before the open is shown still gets its card', async ({ page }) => {
    await start(page)
    await writeFile(page, 'coconut.nxsp', await damagedBytes())
    // The show waits until the import has unlinked the session, as on a busy machine.
    await page.evaluate(() => {
        const worker = window.nseStorageTest!.worker as unknown as {
            call: (name: string, ...rest: unknown[]) => Promise<unknown>
        }
        const call = worker.call.bind(worker)
        let found = () => {}
        const unlinked = new Promise<void>((resolve) => (found = resolve))
        worker.call = async (name, ...rest) => {
            if (name === 'readSession') await unlinked
            const result = await call(name, ...rest)
            if (name === 'openUnlink') found()
            return result
        }
    })
    await openFile(page, 'coconut.nxsp')
    await expect(
        notice(page).filter({
            hasText: 'The history in coconut.nxsp is damaged. Saving will create a separate file.',
        }),
    ).toBeVisible()
    expect((await sessionOf(page)).copyOf).toEqual({ name: 'coconut.nxsp', bound: true })
})

test('a reload mid-import resumes it from the bound handle', async ({ page }) => {
    await start(page)
    await writeFile(page, 'coconut.nxsp', await freshBytes())
    // No batch runs before the reload, so the reload finds the whole import pending.
    await holdImport(page)
    await openFile(page, 'coconut.nxsp')
    await expect(notice(page).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    const session = await sessionOf(page)
    const chain = await chainOf(page, session.sessionId)
    const token = (await handleToken(page, chain.chainId as string, 'file'))!
    // The next load reads the handle back as a fake one: a spec cannot hold a real OPFS handle.
    if (!memoryFiles(page))
        await page.addInitScript(
            ({ token, name }) => {
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

// The damage comes after the startup gate lifts, while the first-visit dialog is open on a load
// where it is due: it closes the dialog, and the card says so.
test('damage a resumed import finds closes the first-visit dialog, and its card shows', async ({
    page,
}) => {
    test.skip(memoryFiles(page), 'the held read needs the OPFS handle')
    await start(page)
    await writeFile(page, 'coconut.nxsp', await damagedBytes())
    // No batch runs before the reload, so the reload finds the whole import pending.
    await holdImport(page)
    await openFile(page, 'coconut.nxsp')
    await expect(notice(page).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    const session = await sessionOf(page)
    const chain = await chainOf(page, session.sessionId)
    const token = (await handleToken(page, chain.chainId as string, 'file'))!
    // The resume reads the file only once the spec lets it, so the damage comes after the dialog
    // has opened, as on a slow disk.
    await page.addInitScript(
        ({ token, name }) => {
            let release = () => {}
            const held = new Promise<void>((resolve) => (release = resolve))
            ;(window as unknown as { releaseFile: () => void }).releaseFile = release
            const opfs = async () => (await navigator.storage.getDirectory()).getFileHandle(name)
            const handle = {
                kind: 'file',
                name,
                getFile: async () => {
                    await held
                    return (await opfs()).getFile()
                },
                queryPermission: () => Promise.resolve('granted'),
                isSameEntry: (other: { name?: string }) => Promise.resolve(other.name === name),
            }
            window.nseTestHandles = new Map([[token, handle as unknown as FileSystemFileHandle]])
        },
        { token, name: 'coconut.nxsp' },
    )
    // The next load has no first-visit mark, so the dialog is due.
    await page.addInitScript(() => {
        localStorage.removeItem('sonolus-next-sekai-editor.firstVisitShown')
    })
    await page.reload()
    await waitForStartup(page, { firstVisit: true })
    const dialog = page.getByRole('dialog', { name: 'Next SEKAI Editor' })
    await expect(dialog).toBeVisible()
    await page.evaluate(() => (window as unknown as { releaseFile: () => void }).releaseFile())
    await imported(page)
    await expect(dialog).toHaveCount(0)
    await expect(
        page.locator('.notification-pill').filter({
            hasText: 'The history in coconut.nxsp is damaged. Saving will create a separate file.',
        }),
    ).toBeVisible()
    expect(
        await page.evaluate(() =>
            localStorage.getItem('sonolus-next-sekai-editor.firstVisitShown'),
        ),
    ).toBe('1')
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
    // Startup, recovery and the idle resume check read none.
    await page.waitForTimeout(500)
    expect(await handleReads(page)).toBe(0)
    expect(await storedHandleName(page, chain.chainId as string, 'file')).toBe('coconut.nxsp')
    expect(await handleReads(page)).toBe(1)
})

test("Export's target keeps its handle across a reload, read when Export opens", async ({
    page,
}) => {
    await start(page)
    // This chart's level data, gzipped, opened from a file: the opened file is Export's target.
    const bytes = await page.evaluate(async () => {
        const { buildLevelData } =
            (await import('/src/editor/commands/exportLevel/build.ts')) as typeof import('../../src/editor/commands/exportLevel/build')
        return [...new Uint8Array(await new Response(await buildLevelData()).arrayBuffer())]
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
    // No batch runs before the reload.
    await holdImport(page)
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
    // The import is still running; the open itself has settled, so the reload is not an unfinished open.
    await openingSettled(page)
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
    await holdImport(page)
    await openFile(page, 'coconut.nxsp')
    await expect(notice(page).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    const outcome = await page.evaluate(async () => {
        const { session } =
            (await import('/src/history/session.ts')) as typeof import('../../src/history/session')
        const { whenImported } =
            (await import('/src/local/open/importLoop.ts')) as typeof import('../../src/local/open/importLoop')
        const waiting = whenImported(session.value.sessionId)
        // Released once the wait has begun.
        ;(window as unknown as { releaseImport: () => void }).releaseImport()
        const result = await waiting
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
            hasText: '“coconut.nxsp” is open in another tab or window, so this is a separate copy.',
        }),
    ).toBeVisible()
    await expect(notice(other).locator('svg[data-severity]')).toHaveAttribute(
        'data-severity',
        'info',
    )
    const session = await sessionOf(other)
    expect(session.file).toBeUndefined()
    expect(session.copyOf).toEqual({ name: 'coconut.nxsp', bound: true })
    expect(session.docId).not.toBe('doc')
    // The first tab keeps its binding.
    expect((await sessionOf(page)).file?.name).toBe('coconut.nxsp')
})

/**
 * The page has finished opening: it keeps no record of an opening, so a reload asks nothing. The
 * reload after it runs under the real guard, which the config's default turns off.
 */
const openingSettled = async (page: Page) => {
    await expect
        .poll(() =>
            page.evaluate(() =>
                Object.keys(localStorage).filter((key) => key.includes('.opening.')),
            ),
        )
        .toEqual([])
    await page.evaluate(() => localStorage.removeItem('nse.test.noOpeningGuard'))
}

test('a separate copy keeps its label after a reload', async ({ page, context }) => {
    await start(page)
    await writeFile(page, 'coconut.nxsp', await freshBytes())
    await openFile(page, 'coconut.nxsp')
    await expect(notice(page).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    await imported(page)
    const other = await context.newPage()
    await start(other)
    await openFile(other, 'coconut.nxsp')
    await expect(notice(other).filter({ hasText: 'so this is a separate copy.' })).toBeVisible()
    await imported(other)
    await expect(other.locator('[data-status-text]')).toContainText('separate copy of coconut.nxsp')
    await openingSettled(other)
    await other.reload()
    await waitForStartup(other)
    await expect
        .poll(async () => (await sessionOf(other)).copyOf)
        .toEqual({
            name: 'coconut.nxsp',
            bound: true,
        })
    expect((await sessionOf(other)).file).toBeUndefined()
    await expect(other.locator('[data-status-text]')).toContainText('separate copy of coconut.nxsp')
    // The next reload keeps it too.
    await openingSettled(other)
    await other.reload()
    await waitForStartup(other)
    await expect(other.locator('[data-status-text]')).toContainText('separate copy of coconut.nxsp')
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
    await expect(notice(page).locator('svg[data-severity]')).toHaveAttribute(
        'data-severity',
        'info',
    )
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
    await expect(notice(page).filter({ hasText: 'The BGM is not loaded.' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Choose Audio…' })).toBeVisible()
    await imported(page)
    const session = await sessionOf(page)
    expect(session.file?.name).toBe('coconut.nxsp')
    const chain = await chainOf(page, session.sessionId)
    // Included, but not held: a Save adds its bytes once chosen; nothing is kept.
    expect('options' in (chain.file as Row)).toBe(false)
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
    await expect(dialog).toContainText('File Created by a Newer Version of Next SEKAI Editor')
    await expect(dialog.getByRole('button', { name: 'Open the Level' })).toBeFocused()
    await confirmWhenReady(dialog.getByRole('button', { name: 'Open the Level' }), dialog)
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

test('a newer major version whose level is refused is an error card', async ({ page }) => {
    await start(page)
    const bytes = await changedBytes((items) => {
        const project = jsonOf(items, 'project.json')
        project.version = 2
        setJson(items, 'project.json', project)
        setJson(items, 'level.json', { entities: [] })
    })
    await writeFile(page, 'coconut.nxsp', bytes)
    await openFile(page, 'coconut.nxsp')
    const dialog = page
        .getByRole('dialog')
        .filter({ hasText: 'Only the level can be opened from this file.' })
    await confirmWhenReady(dialog.getByRole('button', { name: 'Open the Level' }), dialog)
    const card = notice(page).filter({
        hasText:
            'This file was created by a newer version of Next SEKAI Editor and cannot be opened.',
    })
    await expect(card).toBeVisible()
    await expect(card.locator('svg[data-severity]')).toHaveAttribute('data-severity', 'error')
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
    // The stem: the extension is not part of the name (stale before AUD-B-2, which pinned the extension).
    expect(session.sourceName).toBe('coconut')
    expect(await noteCount(page)).toBeGreaterThan(0)
})

test('a .nxsp keeps the file stem as its source name, so Export suggests "coconut" and not "coconut.nxsp"', async ({
    page,
}) => {
    await start(page)
    await writeFile(page, 'coconut.nxsp', await freshBytes())
    await openFile(page, 'coconut.nxsp')
    await expect(notice(page).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    await imported(page)

    const session = await sessionOf(page)
    expect(session.sourceName).toBe('coconut')
    const { chains } = await rows(page, ['chains'])
    expect(chains!.find((row) => row.value.head === session.sessionId)!.value.sourceName).toBe(
        'coconut',
    )

    await page.keyboard.press('Shift+P')
    const field = page.getByRole('dialog').getByRole('textbox', { name: 'File Name' })
    await expect(field).toHaveValue('coconut')
    // The picker is offered "coconut.nsld", never "coconut.nxsp.nsld".
    await expect(page.getByRole('dialog').locator('[data-export-name]')).toBeVisible()
})

/** Picks a ZIP of the given entries as Open File… would, from OPFS. */
const openZip = async (page: Page, name: string, entries: [string, string][]) => {
    const zip = await buildZip(
        entries.map(([entry, text]) => ({
            name: entry,
            method: 'deflate' as const,
            data: new TextEncoder().encode(text),
        })),
    )
    await writeFile(page, name, [...new Uint8Array(await zip.arrayBuffer())])
    await openFile(page, name)
}

test('an archive of project files says to unzip it, and opens nothing', async ({ page }) => {
    await start(page)
    const before = await sessionOf(page)
    await openZip(page, 'backup.zip', [
        ['manifest.json', '{}'],
        ['coconut.nxsp', ''],
    ])
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText(
        'This ZIP contains several project files. Unzip it and open them one by one.',
    )
    await expect(dialog).not.toContainText('not a project file')
    await dialog.getByRole('button', { name: 'OK' }).click()
    await expect(dialog).toHaveCount(0)
    expect((await sessionOf(page)).sessionId).toBe(before.sessionId)
})

test('a Sonolus package points to Preview Assets, which opens', async ({ page }) => {
    await start(page)
    const before = await sessionOf(page)
    await openZip(page, 'skin.scp', [
        ['sonolus/skins/list', '{"pageCount":1,"items":[]}'],
        ['sonolus/info', '{}'],
    ])
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText(
        'This is a Sonolus package. To use its skin or other assets, choose it in Preview Assets.',
    )
    await expect(dialog).not.toContainText('not a project file')
    // A press in the dialog's first moments is ignored (the activation guard): press until it counts.
    await expect(async () => {
        await dialog.getByRole('button', { name: 'Preview Assets' }).click({ timeout: 1000 })
        await expect(page.getByRole('dialog', { name: 'Preview Assets' })).toBeVisible({
            timeout: 1000,
        })
    }).toPass()
    expect((await sessionOf(page)).sessionId).toBe(before.sessionId)
})

test('a package can be dismissed without opening Preview Assets', async ({ page }) => {
    await start(page)
    await openZip(page, 'skin.scp', [['sonolus/info', '{}']])
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('This is a Sonolus package.')
    await expect(async () => {
        await dialog.getByRole('button', { name: 'OK' }).click({ timeout: 1000 })
        await expect(dialog).toHaveCount(0, { timeout: 1000 })
    }).toPass()
})

test('any other ZIP is still "not a project file"', async ({ page }) => {
    await start(page)
    await openZip(page, 'photos.zip', [['a.png', 'x']])
    await expect(page.getByRole('dialog', { name: 'Open' })).toContainText(
        'This ZIP is not a project file.',
    )
})

// A newer `patch` is a line of its own on a whole open: beside what else the
// open has to say, and given way only to an earlier session's unsaved-changes notice.

const PATCH_LINE =
    'This file was created by a newer version of Next SEKAI Editor. Some content may not be shown.'

const patchBytes = async (change?: (items: Item[]) => Item[] | void) => {
    const file = await crafted((items) => {
        setJson(items, 'project.json', { ...jsonOf(items, 'project.json'), patch: 3 })
        return change?.(items) ?? items
    })
    return [...new Uint8Array(await file.arrayBuffer())]
}

test('a newer patch beside a file bound in another tab: the separate-copy line and the patch line, in one card', async ({
    page,
    context,
}) => {
    await start(page)
    await writeFile(page, 'coconut.nxsp', await patchBytes())
    await openFile(page, 'coconut.nxsp')
    await expect(notice(page).filter({ hasText: PATCH_LINE })).toBeVisible()
    await imported(page)
    expect((await sessionOf(page)).file?.name).toBe('coconut.nxsp')
    const other = await context.newPage()
    await start(other)
    await openFile(other, 'coconut.nxsp')
    const card = notice(other).filter({
        hasText: '“coconut.nxsp” is open in another tab or window, so this is a separate copy.',
    })
    await expect(card).toBeVisible()
    await expect(card).toContainText(PATCH_LINE)
    expect((await sessionOf(other)).file).toBeUndefined()
})

test('a newer patch beside a BGM that is not loaded: both lines, with Choose Audio', async ({
    page,
}) => {
    await start(page)
    // The file records its BGM and does not hold it: metadata only, as a Save without it writes.
    await writeFile(
        page,
        'coconut.nxsp',
        await patchBytes((items) => {
            const project = jsonOf(items, 'project.json')
            const { filename, type, sha256, size } = project.bgm
            project.bgm = { filename, type, hash: sha256.slice(0, 32), size }
            setJson(items, 'project.json', project)
            return items.filter((item) => !item.name.startsWith('bgm/'))
        }),
    )
    await openFile(page, 'coconut.nxsp')
    const card = notice(page).filter({ hasText: PATCH_LINE })
    await expect(card).toBeVisible()
    await expect(card).toContainText('The BGM is not loaded.')
    await expect(card.getByRole('button', { name: 'Choose Audio…' })).toBeVisible()
    // Bound, with its history, as a whole open is.
    await imported(page)
    expect((await sessionOf(page)).file?.name).toBe('coconut.nxsp')
})

test("a newer patch gives way to an earlier session's unsaved-changes notice, which keeps the work", async ({
    page,
}) => {
    await start(page)
    await writeFile(page, 'coconut.nxsp', await patchBytes())
    await openFile(page, 'coconut.nxsp')
    await expect(notice(page).filter({ hasText: PATCH_LINE })).toBeVisible()
    await imported(page)
    await edit(page, 777)
    await page.evaluate(() => window.nseFlushTest!.flusher.flush({ strict: true }))
    await page.keyboard.press('n')
    await confirmNew(page)
    await expect(notice(page).filter({ hasText: 'New level' })).toBeVisible()
    await openFile(page, 'coconut.nxsp')
    await expect(
        notice(page).filter({
            hasText: 'Opened coconut.nxsp. You have unsaved changes to it from',
        }),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Restore Session' })).toBeVisible()
    await expect(notice(page).filter({ hasText: PATCH_LINE })).toHaveCount(0)
})

// A read of storage that fails is a failure, not "nothing". The open has
// succeeded whatever its earlier-chains read says, and shows its ordinary notice; a binding check
// that cannot be answered opens a separate copy.

/** Makes the storage worker's `method` reject from now on, as a worker that stopped answering. */
const failReads = (page: Page, methods: string[]) =>
    page.evaluate((methods) => {
        const worker = window.nseStorageTest!.worker
        worker.call = new Proxy(worker.call, {
            apply(target, thisArg: unknown, args: [string, ...unknown[]]) {
                if (methods.includes(args[0])) {
                    const error = new Error('The storage worker stopped answering (spec)')
                    error.name = 'TimeoutError'
                    return Promise.reject(error)
                }
                return Reflect.apply(target, thisArg, args) as unknown
            },
        })
    }, methods)

test('an open whose earlier chains cannot be read still opens, with the ordinary line, Reopen and no error', async ({
    page,
}) => {
    await start(page)
    await writeFile(page, 'coconut.nxsp', await freshBytes())
    await edit(page, 777)
    await page.evaluate(() => window.nseFlushTest!.flusher.flush({ strict: true }))
    await failReads(page, ['openEarlierChains'])
    await openFile(page, 'coconut.nxsp')
    await expect(notice(page).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Reopen/ })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await imported(page)
    expect((await sessionOf(page)).file?.name).toBe('coconut.nxsp')
})

for (const method of ['readBindings', 'readHandle'])
    test(`a binding check that cannot be answered (${method} fails) opens a separate copy with the ordinary line`, async ({
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
        await failReads(other, [method])
        await openFile(other, 'coconut.nxsp')
        await expect(notice(other).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()
        await expect(notice(other).filter({ hasText: 'another tab or window' })).toHaveCount(0)
        const session = await sessionOf(other)
        expect(session.file).toBeUndefined()
        expect(session.copyOf).toEqual({ name: 'coconut.nxsp', bound: true })
        // The status bar says it is a copy.
        await expect(other.locator('[data-status-text]')).toContainText(
            'separate copy of coconut.nxsp',
        )
        // The first tab keeps its binding.
        expect((await sessionOf(page)).file?.name).toBe('coconut.nxsp')
    })

declare global {
    interface Window {
        decoded: number[]
    }
}

test('a project file over 256 MB asks first: Cancel opens nothing, Open Anyway reads it', async ({
    page,
}) => {
    test.skip(memoryFiles(page), 'the handle fixture holds small files only')
    await start(page)
    await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory()
        const handle = await root.getFileHandle('huge.nxsp', { create: true })
        const writable = await handle.createWritable()
        await writable.truncate(257 * 1024 * 1024)
        await writable.write({ type: 'write', position: 0, data: new Uint8Array([80, 75, 3, 4]) })
        await writable.close()
    })
    const before = await sessionOf(page)
    await openFile(page, 'huge.nxsp')
    const dialog = page.getByRole('dialog').filter({ hasText: 'huge.nxsp' })
    await expect(dialog).toContainText(said(en.open.large.title, 'huge.nxsp'))
    await expect(dialog).toContainText(said(en.open.large.body, '269 MB'))
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await confirmWhenReady(dialog.getByRole('button', { name: 'Cancel' }), dialog)
    await expect(dialog).toHaveCount(0)
    expect((await sessionOf(page)).sessionId).toBe(before.sessionId)
    expect((await rows(page, ['sessions'])).sessions).toHaveLength(0)

    await openFile(page, 'huge.nxsp')
    await expect(dialog).toHaveCount(1)
    await confirmWhenReady(dialog.getByRole('button', { name: 'Open Anyway' }), dialog)
    // The reader refuses the file: it is the project reader's own answer, past the confirm.
    await expect(
        page.getByRole('dialog').filter({ hasText: /damaged|not a project file/ }),
    ).toBeVisible()
})

/** Records the sizes of the bytes the page decodes as audio. */
const spyOnDecoding = (page: Page) =>
    page.addInitScript(() => {
        window.decoded = []
        const decode = BaseAudioContext.prototype.decodeAudioData
        BaseAudioContext.prototype.decodeAudioData = function (...args) {
            window.decoded.push(args[0].byteLength)
            return Reflect.apply(decode, this, args) as Promise<AudioBuffer>
        }
    })

/**
 * Prepares `long.nxsp`, a project file whose BGM is a silent MPEG 2.5 stream at 8 kbps: 72-byte
 * frames of 0.072 s, 90 minutes and a second. Returns the BGM's size.
 */
const writeLongBgmFile = async (page: Page) => {
    const frames = 75_020
    const mp3 = new Uint8Array(frames * 72)
    for (let i = 0; i < frames; i++) mp3.set([0xff, 0xe3, 0x18, 0xc0], i * 72)
    const sha256 = createHash('sha256').update(mp3).digest('hex')
    const bgm = {
        bytes: mp3,
        sha256,
        ref: {
            hash: sha256.slice(0, 32),
            filename: 'long.mp3',
            size: mp3.length,
            type: 'audio/mpeg',
        },
    }
    const file = await executePlan(planNxsp(fresh(bgm).input).plan, new Map())
    const base64 = Buffer.from(await file.arrayBuffer()).toString('base64')
    await page.evaluate(async (base64) => {
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
        const root = await navigator.storage.getDirectory()
        const handle = await root.getFileHandle('long.nxsp', { create: true })
        const writable = await handle.createWritable()
        await writable.write(bytes)
        await writable.close()
    }, base64)
    return mp3.length
}

const REFUSED = said(en.notice.bgmMayBeTooLong, BGM_MAX_MINUTES)

test('a BGM longer than 90 minutes in a project is not decoded, and a card says so with Choose Audio', async ({
    page,
}) => {
    test.skip(memoryFiles(page), 'the handle fixture holds small files only')
    await spyOnDecoding(page)
    await start(page)
    const size = await writeLongBgmFile(page)
    await openFile(page, 'long.nxsp')
    const card = notice(page).filter({ hasText: REFUSED })
    await expect(card).toBeVisible()
    await expect(card.getByRole('button', { name: en.notice.chooseAudio })).toBeVisible()
    await imported(page)
    // The player's own clips decode; the long BGM's bytes never reach the decoder.
    expect(await page.evaluate(() => window.decoded)).not.toContain(size)
    // The bytes are kept in storage: Choose Audio is not needed to get them back.
    const { media } = await rows(page, ['media'])
    expect(media!.some((row) => JSON.stringify(row.value).includes('long.mp3'))).toBe(true)
})

test('a refused BGM is a row of the open card, which keeps Restore Session for earlier work', async ({
    page,
}) => {
    test.skip(memoryFiles(page), 'the handle fixture holds small files only')
    await spyOnDecoding(page)
    await start(page)
    await writeLongBgmFile(page)
    await openFile(page, 'long.nxsp')
    await expect(notice(page).filter({ hasText: REFUSED })).toBeVisible()
    await imported(page)
    await edit(page, 777)
    await page.evaluate(() => window.nseFlushTest!.flusher.flush({ strict: true }))
    await page.keyboard.press('n')
    await confirmNew(page)
    await expect(notice(page).filter({ hasText: 'New level' })).toBeVisible()
    await openFile(page, 'long.nxsp')
    const card = notice(page).filter({
        hasText: said(en.open.unsavedChanges, 'long.nxsp', '').split(' from')[0],
    })
    await expect(card).toBeVisible()
    await expect(card).toContainText(REFUSED)
    await expect(card.getByRole('button', { name: en.open.restoreIt })).toBeVisible()
    await expect(card.getByRole('button', { name: en.notice.chooseAudio })).toBeVisible()
    // A screen reader hears the earlier-work text and the refusal row.
    const region = page.locator('[data-notice-region]')
    await expect(region).toContainText(
        said(en.open.unsavedChanges, 'long.nxsp', '').split(' from')[0]!,
    )
    await expect(region).toContainText(REFUSED)
})

test('a damage warning and a refused BGM end up in one card, whichever comes first', async ({
    page,
}) => {
    await start(page)
    const damaged = said(en.open.damagedHistory, 'coconut.nxsp')
    const refused = said(en.notice.bgmTooLong, BGM_MAX_MINUTES)
    const warn = () =>
        page.evaluate(async (message) => {
            const { notifyWarning } =
                (await import('/src/editor/media/refusalCard.ts')) as typeof import('../../src/editor/media/refusalCard')
            notifyWarning(() => message)
        }, damaged)
    const refuse = (hash: string) =>
        page.evaluate(async (hash) => {
            const { noticeRefused } =
                (await import('/src/editor/media/heldBgm.ts')) as typeof import('../../src/editor/media/heldBgm')
            const { TaskFailure } =
                (await import('/src/utils/error.ts')) as typeof import('../../src/utils/error')
            noticeRefused(hash, new TaskFailure('audioTooLong', 'longer than the limit'))
        }, hash)
    const card = notice(page).filter({ hasText: damaged })
    const region = page.locator('[data-notice-region]')

    // The warning first, the refusal after: it joins the warning's card.
    await warn()
    await expect(card).toBeVisible()
    await refuse('first')
    await expect(card).toContainText(refused)
    await expect(card.getByRole('button', { name: en.notice.chooseAudio })).toBeVisible()
    await expect(region).toContainText(refused)

    // A new session, the refusal first: the warning keeps its row.
    await page.evaluate(async () => {
        const { resetState } =
            (await import('/src/history/index.ts')) as typeof import('../../src/history')
        resetState(false)
    })
    await refuse('second')
    await expect(notice(page).filter({ hasText: refused })).toBeVisible()
    await warn()
    await expect(card).toContainText(refused)
    await expect(card.getByRole('button', { name: en.notice.chooseAudio })).toBeVisible()
    await expect(region).toContainText(damaged)
    await expect(region).toContainText(refused)
})

test('at load a refused stored BGM is a row of the start-up card, whose action stays', async ({
    page,
    context,
}) => {
    test.skip(memoryFiles(page), 'the handle fixture holds small files only')
    await start(page)
    await writeLongBgmFile(page)
    await openFile(page, 'long.nxsp')
    await expect(notice(page).filter({ hasText: REFUSED })).toBeVisible()
    await imported(page)
    await openingSettled(page)
    await edit(page, 777)
    await page.evaluate(() => window.nseFlushTest!.flusher.flush({ strict: true }))
    // A new visit continues that session, with its Continued line and Open History.
    page.on('dialog', (dialog) => void dialog.accept())
    await closePage(page, { runBeforeUnload: true })
    const next = await context.newPage()
    await start(next)
    const card = notice(next).filter({ hasText: REFUSED })
    await expect(card).toBeVisible()
    await expect(card).toContainText(en.load.continued.slice(0, en.load.continued.indexOf('{0}')))
    await expect(card.getByRole('button', { name: en.notice.chooseAudio })).toBeVisible()
    await expect(card.getByRole('button', { name: en.load.openHistory })).toBeVisible()
})
