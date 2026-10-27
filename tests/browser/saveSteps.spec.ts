import { expect, test, type Page } from '@playwright/test'
import { openHistory } from './historyJourney'
import {
    chainOf,
    edit,
    flushed,
    notice,
    pressSave,
    projectOf,
    rows,
    saveDialog,
    sessionOf,
    start,
    submitSave,
} from './saveFlows'

// The History row of the Save dialogs counts the steps the file would hold: the
// entries of the chain, with no `save` entry of the write itself, which is the number Go To and
// the Timeline count. Until the estimate says so the row shows no number, never "0 steps".

type Row = Record<string, unknown>

const dialogSteps = async (page: Page, title?: string) => {
    const size = saveDialog(page, title).locator('[data-save-row="history"] [data-save-size]')
    await expect(size).toHaveText(/^[\d,]+ steps? · /)
    const text = (await size.textContent()) ?? ''
    return Number(/^([\d,]+) step/.exec(text)![1]!.replaceAll(',', ''))
}

const cancel = async (page: Page, title?: string) => {
    const dialog = saveDialog(page, title)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
}

/** The Timeline's count: the History dialog's Go To, the day's steps (one session, one day). */
const timelineSteps = async (page: Page) => {
    await flushed(page)
    await openHistory(page)
    await page.locator('[data-history-surface="dialog"] [data-history-goto-button]').click()
    const items = page.locator('[data-history-goto] [data-goto-item]')
    // Now, then the day (with a row for each of its sessions when there are several).
    await expect(items.nth(1)).toBeVisible()
    await expect(items.nth(1)).toContainText(/\d steps?/)
    const text = (await items.nth(1).textContent()) ?? ''
    const steps = Number(/([\d,]+) steps?/.exec(text)![1]!.replaceAll(',', ''))
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-history-goto]')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-history-surface="dialog"]')).toHaveCount(0)
    return steps
}

const saveAs = (page: Page) =>
    page.evaluate(async () => {
        const { commands } = await import('/src/editor/commands/index.ts')
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        void runCommand(commands.saveAs, 'button')
    })

test('Save shows the steps the Timeline counts, and no number before they are known', async ({
    page,
}) => {
    await start(page)
    for (let beat = 1; beat <= 5; beat++) await edit(page, beat)
    await pressSave(page)
    const dialog = saveDialog(page)
    await expect(dialog).toBeVisible()
    // Never "0 steps": the label alone until the estimate has the count.
    await expect(dialog.locator('[data-save-row="history"]')).not.toContainText('0 steps')
    const shown = await dialogSteps(page)
    await cancel(page)
    // The five edits and the one that starts the session at least.
    expect(shown).toBeGreaterThanOrEqual(6)
    expect(shown).toBe(await timelineSteps(page))
})

test("Save As shows the steps the Timeline counts, the first Save's entry among them", async ({
    page,
}) => {
    await start(page)
    for (let beat = 1; beat <= 3; beat++) await edit(page, beat)
    await pressSave(page)
    const first = await dialogSteps(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    await expect
        .poll(async () => (await chainOf(page)).file)
        .toMatchObject({ name: 'coconut.nxsp' })
    await saveAs(page)
    const again = await dialogSteps(page, 'Save As')
    await cancel(page, 'Save As')
    // The Save wrote its own entry, which the chain holds now.
    expect(again).toBe(first + 1)
    expect(again).toBe(await timelineSteps(page))
})

test("Recent Sessions' Save… shows the steps its session holds", async ({ page }) => {
    await start(page)
    for (let beat = 1; beat <= 4; beat++) await edit(page, beat)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    const earlier = await sessionOf(page)
    // Another session in this tab.
    await page.evaluate(async () => {
        const { resetState } = await import('/src/history/index.ts')
        resetState(false)
    })
    await edit(page, 9)
    await flushed(page)
    const { entries } = await rows(page, ['entries'])
    const held = entries!.filter((row) => row.value.sessionId === earlier.sessionId).length
    expect(held).toBeGreaterThanOrEqual(6)
    await page.evaluate((sessionId) => {
        void import('/src/editor/save/flow.ts').then((flow) => flow.saveToFile(sessionId))
    }, earlier.sessionId)
    expect(await dialogSteps(page)).toBe(held)
    await cancel(page)
})

// A fork is a new chain: the Timeline goes on into its parent's chain, but a file holds only the
// chain's own rows, so the dialog counts those, and the file agrees with it.
test('a fork shows the steps of its own chain, which are the steps its file holds', async ({
    context,
}) => {
    const b = await context.newPage()
    await start(b)
    for (let beat = 1; beat <= 3; beat++) await edit(b, beat)
    await pressSave(b)
    await submitSave(b, 'coconut')
    await expect(notice(b).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    const { sessionId } = await sessionOf(b)
    await flushed(b)
    const a = await context.newPage()
    await start(a)
    await a.evaluate(async (sessionId) => {
        const { restoreCopy } = await import('/src/editor/switch.ts')
        await restoreCopy(sessionId)
    }, sessionId)
    await expect.poll(async () => (await sessionOf(a)).copyOf?.name).toBe('coconut.nxsp')
    await edit(a, 4)
    await edit(a, 5)
    await pressSave(a)
    const shown = await dialogSteps(a)
    // The fork's own rows: its continue entry and the two edits, none of the parent chain's five.
    await flushed(a)
    const { sessions, entries } = await rows(a, ['sessions', 'entries'])
    const { sessionId: forkId } = await sessionOf(a)
    const chainId = sessions!.find((row) => row.value.id === forkId)!.value.chainId
    const own = sessions!.filter((row) => row.value.chainId === chainId).map((row) => row.value.id)
    expect(shown).toBe(entries!.filter((row) => own.includes(row.value.sessionId as string)).length)
    expect(shown).toBe(3)
    await submitSave(a, 'fork')
    await expect(notice(a).filter({ hasText: 'Saved to fork.nxsp' })).toBeVisible()
    // The file holds those rows and its own `save` entry.
    expect((((await projectOf(a, 'fork.nxsp')).history as Row).entries as number) - 1).toBe(shown)
})
