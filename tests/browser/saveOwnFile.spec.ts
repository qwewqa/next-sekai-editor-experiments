import { expect, test, type Page } from '@playwright/test'
import { executePlan, planNxsp } from '../../src/local/nxsp'
import { fresh } from '../local/nxsp/chain'
import { waitForStartup } from './editorFixture'
import {
    chainOf,
    deferResume,
    edit,
    editPastUndo,
    holdImport,
    importing,
    notice,
    pickerCalls,
    pressSave,
    projectOf,
    prompts,
    queuePicks,
    readFile,
    releaseImport,
    resumeImport,
    rows,
    saveDialog,
    sessionOf,
    start,
    submitSave,
    thinUndone,
    writeFile,
} from './saveFlows'

// Export reads the chain's own file before its picker and restores held bytes under the pick's
// lock. Save waits for an open's import, also after a reload.

type Row = Record<string, unknown>

const saveAs = (page: Page) =>
    page.evaluate(async () => {
        const { commands } = await import('/src/editor/commands/index.ts')
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        void runCommand(commands.saveAs, 'button')
    })

/** A dialog ignores presses in its first moments; a read first has time to finish. */
const settle = (page: Page) => page.waitForTimeout(400)

/** Saved to coconut.nxsp with an undone row, then cleanup took that row: storage is short. */
const shortChain = async (page: Page) => {
    await start(page)
    await editPastUndo(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    const before = await projectOf(page, 'coconut.nxsp')
    const bytes = await readFile(page, 'coconut.nxsp')
    return { before, bytes }
}

test("Export's Choose Another… after its dialog closed reads the chain's own file again before its picker", async ({
    page,
}) => {
    const { before } = await shortChain(page)
    expect(await thinUndone(page)).toBe(true)
    await queuePicks(page, ['coconut.nxsp'])
    await page.keyboard.press('Shift+P')
    await expect(page.getByRole('dialog').filter({ hasText: 'Export Level Data' })).toBeVisible()
    await settle(page)
    await page.keyboard.press('Enter')
    // Written again from the bytes read and refused: not level data.
    const refused = page.getByRole('dialog').filter({ hasText: 'is not level data' })
    await expect(refused).toBeVisible()
    const first = await projectOf(page, 'coconut.nxsp')
    expect((first.revision as Row).completeFrom).toBe((before.revision as Row).completeFrom)
    await settle(page)
    await queuePicks(page, ['coconut.nxsp'])
    await refused.getByRole('button', { name: 'Choose Another…' }).click()
    await expect(refused).toBeVisible()
    await expect
        .poll(async () => ((await projectOf(page, 'coconut.nxsp')).revision as Row).parent)
        .toBe((first.revision as Row).id)
    // Read again before the second picker: an append, every step of the file kept.
    const after = await projectOf(page, 'coconut.nxsp')
    expect(after.id).toBe(before.id)
    expect((after.revision as Row).completeFrom).toBe((before.revision as Row).completeFrom)
})

test("Export's pick of the chain's own file that is not written again gets the bytes read back", async ({
    page,
}) => {
    const { bytes } = await shortChain(page)
    expect(await thinUndone(page)).toBe(true)
    // Another Save holds the reservation.
    await page.evaluate(() => {
        ;(window as { held?: unknown }).held = window.nseFlushTest!.flusher.reserveSave()
    })
    await queuePicks(page, ['coconut.nxsp'])
    await page.keyboard.press('Shift+P')
    await expect(page.getByRole('dialog').filter({ hasText: 'Export Level Data' })).toBeVisible()
    await settle(page)
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toContainText('“coconut.nxsp” could not be written.')
    expect(await readFile(page, 'coconut.nxsp')).toEqual(bytes)
})

test("a stale reservation's release never ends a later Save's reservation of the same seq", async ({
    page,
}) => {
    await shortChain(page)
    // When the Save lets its `seq` go, another reserves it at once, as Export's pick could.
    await page.evaluate(() => {
        type Flusher = {
            endSave: (...args: unknown[]) => Promise<unknown>
            reserveSave: () => { seq: number } | undefined
        }
        const flusher = window.nseFlushTest!.flusher as unknown as Flusher
        const own = flusher.endSave.bind(flusher)
        const seen = window as unknown as { held?: { seq: number } }
        flusher.endSave = (...args: unknown[]) => {
            const done = own(...args)
            if (!seen.held && args[1] === undefined && args[3] !== true)
                seen.held = flusher.reserveSave()
            return done
        }
    })
    await saveAs(page)
    await expect(saveDialog(page, 'Save As')).toBeVisible()
    await queuePicks(page, [null])
    await submitSave(page, undefined, 'Save As')
    await expect(saveDialog(page, 'Save As')).toHaveCount(0)
    await expect
        .poll(() =>
            page.evaluate(() => (window as unknown as { held?: { seq: number } }).held?.seq),
        )
        .toBeDefined()
    await page.waitForTimeout(500)
    // The later Save still holds its reservation: the stale end ended nothing (identity, not `seq`).
    const { held, same } = await page.evaluate(() => {
        const flusher = window.nseFlushTest!.flusher as unknown as {
            session?: { reserved?: { seq: number } }
        }
        const held = (window as unknown as { held?: { seq: number } }).held
        return { held: held?.seq, same: flusher.session?.reserved === held }
    })
    expect(held).toBeDefined()
    expect(same).toBe(true)
})

const freshBytes = async () =>
    new Uint8Array(await (await executePlan(planNxsp(fresh().input).plan, new Map())).arrayBuffer())

const openFile = async (page: Page, name: string) => {
    await queuePicks(page, [name])
    await page.keyboard.press('o')
    await expect(notice(page).filter({ hasText: name }).first()).toBeVisible()
}

test("the Save dialog shows no count while an open's import runs, and counts once it ends", async ({
    page,
}) => {
    await start(page)
    await writeFile(page, 'coconut.nxsp', await freshBytes())
    await holdImport(page, 1)
    await openFile(page, 'coconut.nxsp')
    await saveAs(page)
    const dialog = saveDialog(page, 'Save As')
    await expect(dialog).toBeVisible()
    const total = dialog.locator('[data-save-total]')
    await expect(total).toHaveText('Estimating size…')
    await page.waitForTimeout(1500)
    await expect(total).toHaveText('Estimating size…')
    await expect(dialog).not.toContainText(/\d steps? ·/)
    await releaseImport(page)
    await expect(total).toHaveText(/^Total: about /, { timeout: 15_000 })
    await expect(dialog).toContainText(/\d steps? ·/)
})

/**
 * Opens coconut.nxsp with its import held, then reloads mid-import with its handle readable. The
 * resumed import is held too; the startup resume waits for `resumeImport` ('late') or never runs.
 */
const reloadMidImport = async (page: Page, resume: 'late' | 'never') => {
    await start(page)
    await writeFile(page, 'coconut.nxsp', await freshBytes())
    await holdImport(page)
    await openFile(page, 'coconut.nxsp')
    const chain = await chainOf(page)
    const { handles } = await rows(page, ['handles'])
    const token = (
        handles!.find((row) => row.value.chainId === chain.chainId)!.value.handle as {
            testHandle: string
        }
    ).testHandle
    await page.addInitScript(
        ({ token, name }) => {
            const opfs = async () => (await navigator.storage.getDirectory()).getFileHandle(name)
            const handle = {
                kind: 'file',
                name,
                getFile: async () => (await opfs()).getFile(),
                queryPermission: () => Promise.resolve('granted'),
                isSameEntry: (other: { name?: string }) => Promise.resolve(other.name === name),
            }
            window.nseTestHandles = new Map([[token, handle as unknown as FileSystemFileHandle]])
        },
        { token, name: 'coconut.nxsp' },
    )
    await deferResume(page, { never: resume === 'never' })
    await page.reload()
    await waitForStartup(page)
    // Nothing has resumed the import yet, so the hold is in place before any batch.
    await holdImport(page)
    const { sessions } = await rows(page, ['sessions'])
    expect(sessions!.some((row) => row.value.importPending === true)).toBe(true)
}

/** A Save's "Preparing…" wait for an import. */
const preparing = (page: Page) =>
    page.getByRole('dialog').filter({ has: page.locator('[data-save-preparing]') })

test('a Save right after a reload mid-import waits for the resumed import, then saves', async ({
    page,
}) => {
    await reloadMidImport(page, 'late')
    // The startup resume runs, and the Save finds its import running.
    await resumeImport(page)
    await expect.poll(() => importing(page)).toBe(true)
    await saveAs(page)
    await expect(saveDialog(page, 'Save As')).toBeVisible()
    await settle(page)
    await queuePicks(page, ['other.nxsp'])
    await submitSave(page, 'other', 'Save As')
    await expect(preparing(page)).toBeVisible()
    await releaseImport(page)
    await expect(notice(page).filter({ hasText: 'Saved to other.nxsp' })).toBeVisible({
        timeout: 20_000,
    })
    await expect(page.getByText('could not be prepared')).toHaveCount(0)
})

test('a Save whose import startup never resumed resumes it and saves, never "could not be prepared"', async ({
    page,
}) => {
    await reloadMidImport(page, 'never')
    await saveAs(page)
    await expect(saveDialog(page, 'Save As')).toBeVisible()
    await settle(page)
    await queuePicks(page, ['other.nxsp'])
    await submitSave(page, 'other', 'Save As')
    // No tab runs the import, so the Save's wait resumes it as a reload would.
    await expect(preparing(page)).toBeVisible()
    await expect.poll(() => importing(page)).toBe(true)
    await releaseImport(page)
    await expect(notice(page).filter({ hasText: 'Saved to other.nxsp' })).toBeVisible({
        timeout: 20_000,
    })
    await expect(page.getByText('could not be prepared')).toHaveCount(0)
})

test("Export waits for an open's import before its picker, so a pick of the file never stops the import", async ({
    page,
}) => {
    await start(page)
    await writeFile(page, 'coconut.nxsp', await freshBytes())
    await holdImport(page, 1)
    await openFile(page, 'coconut.nxsp')
    const calls = (await pickerCalls(page)).length
    await queuePicks(page, ['coconut.nxsp'])
    await page.keyboard.press('Shift+P')
    await expect(page.getByRole('dialog').filter({ hasText: 'Export Level Data' })).toBeVisible()
    await settle(page)
    await page.keyboard.press('Enter')
    const waiting = page.getByRole('dialog').filter({ has: page.locator('[data-save-preparing]') })
    await expect(waiting).toBeVisible()
    await expect(waiting).toContainText('Export Level Data')
    await page.waitForTimeout(500)
    // No picker while the import reads the file.
    expect((await pickerCalls(page)).length).toBe(calls)
    await releaseImport(page)
    await expect
        .poll(async () => (await pickerCalls(page)).length, { timeout: 15_000 })
        .toBe(calls + 1)
    await expect(page.getByRole('dialog').filter({ hasText: 'is not level data' })).toBeVisible()
    // The import ended whole: no row left unkept, nothing pending.
    const { entries, sessions } = await rows(page, ['entries', 'sessions'])
    expect(entries!.filter((row) => row.value.kept === false)).toEqual([])
    expect(sessions!.some((row) => row.value.importPending === true)).toBe(false)
})

test("Recent Sessions' Save… shows no count while an open's import runs, and counts once it ends", async ({
    page,
}) => {
    await start(page)
    await writeFile(page, 'coconut.nxsp', await freshBytes())
    await holdImport(page, 1)
    await openFile(page, 'coconut.nxsp')
    const { sessionId } = await sessionOf(page)
    await page.evaluate((sessionId) => {
        void import('/src/editor/save/flow.ts').then((flow) => flow.saveToFile(sessionId))
    }, sessionId)
    const dialog = page.getByRole('dialog').filter({ has: page.locator('[data-save-total]') })
    await expect(dialog).toBeVisible()
    const total = dialog.locator('[data-save-total]')
    await expect(total).toHaveText('Estimating size…')
    await page.waitForTimeout(1500)
    await expect(total).toHaveText('Estimating size…')
    await expect(dialog).not.toContainText(/\d steps? ·/)
    await releaseImport(page)
    await expect(total).toHaveText(/^Total: about /, { timeout: 15_000 })
    await expect(dialog).toContainText(/\d steps? ·/)
})

test('the Save dialog stops counting again when an import stays pending that never runs', async ({
    page,
}) => {
    await reloadMidImport(page, 'never')
    await page.evaluate(() => {
        type Call = (method: string, ...rest: unknown[]) => Promise<unknown>
        const worker = window.nseStorageTest!.worker as unknown as { call: Call }
        const own = worker.call.bind(worker)
        const seen = window as unknown as { estimates: number }
        seen.estimates = 0
        worker.call = (method, ...rest) => {
            if (method === 'estimateSaveSize') seen.estimates++
            return own(method, ...rest)
        }
    })
    await saveAs(page)
    const dialog = saveDialog(page, 'Save As')
    await expect(dialog).toBeVisible()
    const total = dialog.locator('[data-save-total]')
    await expect(total).toHaveText('Estimating size…')
    const estimates = () =>
        page.evaluate(() => (window as unknown as { estimates: number }).estimates)
    await page.waitForTimeout(6000)
    const settled = await estimates()
    await page.waitForTimeout(4000)
    expect(await estimates()).toBe(settled)
    await expect(total).toHaveText('Estimating size…')
})

test('Export with no import to wait for still asks for a press once the press has lapsed', async ({
    page,
}) => {
    // The browser reports the press as gone, as after a slow storage answer.
    await start(page, { override: { activation: false } })
    const calls = (await pickerCalls(page)).length
    await queuePicks(page, ['LevelData'])
    await page.keyboard.press('Shift+P')
    await expect(page.getByRole('dialog').filter({ hasText: 'Export Level Data' })).toBeVisible()
    await settle(page)
    await page.keyboard.press('Enter')
    const preparing = page
        .getByRole('dialog')
        .filter({ has: page.locator('[data-save-preparing]') })
    await expect(preparing).toBeVisible()
    // No picker without a press: it would be refused.
    await page.waitForTimeout(500)
    expect((await pickerCalls(page)).length).toBe(calls)
    await settle(page)
    await preparing.getByRole('button', { name: 'Export', exact: true }).click()
    await expect.poll(async () => (await pickerCalls(page)).length).toBe(calls + 1)
    await expect(notice(page).filter({ hasText: 'Exported to LevelData' })).toBeVisible()
})

test('a saved file opened again after a reload shows no change until an edit', async ({ page }) => {
    await start(page)
    await edit(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    await page.reload()
    await waitForStartup(page)
    await openFile(page, 'coconut.nxsp')
    await expect(notice(page).filter({ hasText: 'Opened coconut.nxsp' })).toBeVisible()

    const label = page.locator('[data-status-text]')
    await expect(label).toHaveText('coconut.nxsp')
    await expect(page).toHaveTitle('coconut.nxsp – Next SEKAI Editor')
    expect(await prompts(page)).toBe(false)
    // Save agrees with the label.
    await pressSave(page)
    await expect(
        notice(page).filter({ hasText: 'No changes since coconut.nxsp was opened' }),
    ).toBeVisible()

    // An edit after the open is a change.
    await edit(page, 2)
    await expect(label).toHaveText('coconut.nxsp •')
    await expect(page).toHaveTitle('coconut.nxsp • – Next SEKAI Editor')
    expect(await prompts(page)).toBe(true)
})
