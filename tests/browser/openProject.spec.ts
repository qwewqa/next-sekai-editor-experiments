import { expect, test, type Page } from '@playwright/test'
import { executePlan, planNxsp } from '../../src/local/nxsp'
import { fresh } from '../local/nxsp/chain'
import { crafted, jsonOf, setJson } from '../local/nxsp/craft'
import { installTestPlatform, waitForStartup } from './editorFixture'

// Opening a `.nxsp` (Part 1 §1.5.4): a new session stored at once and bound to the file, its
// history imported in the background, Undo where the file left off, and the partial opens that
// start a separate copy. Chromium's picker runs on OPFS handles through the platform override.

type Row = Record<string, unknown>

/** A `.nxsp` of the shared test chain (four entries, a BGM and a cover), as bytes. */
const freshBytes = async () => {
    const file = await executePlan(planNxsp(fresh().input).plan, new Map())
    return [...new Uint8Array(await file.arrayBuffer())]
}

const start = async (page: Page, fileSystemAccess: boolean | 'opfs' = 'opfs') => {
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
    await page.addInitScript(installTestPlatform, { fileSystemAccess })
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await waitForStartup(page)
}

/** Writes a file into OPFS, where the override's picker finds it. */
const writeFile = (page: Page, name: string, bytes: number[]) =>
    page.evaluate(
        async ({ name, bytes }) => {
            const root = await navigator.storage.getDirectory()
            const handle = await root.getFileHandle(name, { create: true })
            const writable = await handle.createWritable()
            await writable.write(new Uint8Array(bytes))
            await writable.close()
        },
        { name, bytes },
    )

/** Opens an OPFS file with Open, as Chromium's picker would. */
const openFile = async (page: Page, name: string) => {
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
    // A real OPFS handle never reaches IndexedDB under the override (D16).
    expect((chain.file as Row).handle).toMatchObject({ testHandle: expect.any(String) })
    expect(chain.edited).toBeUndefined()
    expect(sessions!.find((row) => row.value.id === session.sessionId)!.value.origin).toBe('nxsp')
    const own = entries!
        .map((row) => row.value)
        .filter((row) => row.sessionId === session.sessionId)
        .map((row) => [row.seq, row.kind, row.label])
    expect(own).toEqual([
        [1, 'init', 'Imported LevelData'],
        [2, 'edit', 'Added note'],
        [3, 'edit', 'Changed BGM'],
        [4, 'save', 'Saved coconut.nxsp'],
        [5, 'continue', 'Opened coconut.nxsp'],
    ])

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
