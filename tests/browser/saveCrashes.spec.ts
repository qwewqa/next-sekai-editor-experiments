import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { closePage, waitForStartup } from './editorFixture'
import {
    chainById,
    chainOf,
    edit,
    notice,
    pauseAt,
    pickerCalls,
    pressSave,
    projectOf,
    queuePicks,
    reached,
    readFile,
    release,
    rows,
    saveDialog,
    sessionOf,
    start,
    submitSave,
    unpause,
    writeFile,
} from './saveFlows'

// Crashes and races around a save picker: a page killed at each point between the pick and the binding, two pickers on
// one file, and a file replaced between the write and the read-back. A kill is a page closed
// without its unload handlers; a new page of the context continues the session, as a new visit.

type Row = Record<string, unknown>

const savedTo = async (page: Page, name: string) => {
    await edit(page, 1)
    await pressSave(page)
    await submitSave(page, name.replace(/\.nxsp$/, ''))
    await expect(notice(page).filter({ hasText: `Saved to ${name}` })).toBeVisible()
    await expect.poll(async () => (await chainOf(page)).file).toMatchObject({ name })
}

/** Closes a page as a kill does, with nothing paused for the next one. */
const kill = async (page: Page) => {
    await unpause(page)
    await closePage(page, { runBeforeUnload: false })
}

/** A new page of the context: a new visit, which continues the most recent session. */
const visitAgain = async (context: BrowserContext) => {
    const next = await context.newPage()
    await next.goto('/')
    await waitForStartup(next)
    return next
}

const noDialog = (page: Page) => expect(page.getByRole('dialog')).toHaveCount(0)

test('a kill after another tab’s pick: the owner’s next Save fills the emptied file, with no dialog', async ({
    context,
}) => {
    const b = await context.newPage()
    await start(b)
    await savedTo(b, 'coconut.nxsp')
    const before = await projectOf(b, 'coconut.nxsp')

    const a = await context.newPage()
    await start(a)
    await edit(a, 5)
    await pauseAt(a, 'picked')
    await queuePicks(a, ['coconut.nxsp'])
    await pressSave(a)
    await submitSave(a)
    await reached(a, 'picked')
    expect(await readFile(a, 'coconut.nxsp')).toEqual([])
    await kill(a)

    // B was edited since its Save: the emptied file holds nothing to keep.
    await edit(b, 2)
    await pressSave(b)
    await expect
        .poll(async () => (await readFile(b, 'coconut.nxsp'))?.length ?? 0, { timeout: 10_000 })
        .toBeGreaterThan(0)
    await noDialog(b)
    const after = await projectOf(b, 'coconut.nxsp')
    expect(after.id).toBe(before.id)
    expect((after.revision as Row).ancestors).toContain((before.revision as Row).id)
})

test('a self-pick killed after the pick: the next Save fills the file, keeping the identity', async ({
    context,
}) => {
    const page = await context.newPage()
    await start(page)
    await savedTo(page, 'coconut.nxsp')
    const before = await projectOf(page, 'coconut.nxsp')
    await page.evaluate(async () => {
        const { commands } = await import('/src/editor/commands/index.ts')
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        void runCommand(commands.saveAs, 'button')
    })
    await pauseAt(page, 'picked')
    await queuePicks(page, ['coconut.nxsp'])
    await submitSave(page, undefined, 'Save As')
    await reached(page, 'picked')
    await kill(page)

    // Edited since: the file is empty, so it holds nothing to keep.
    const next = await visitAgain(context)
    await expect.poll(async () => (await sessionOf(next)).file?.name).toBe('coconut.nxsp')
    await edit(next, 3)
    await pressSave(next)
    await expect(notice(next).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    await noDialog(next)
    const after = await projectOf(next, 'coconut.nxsp')
    expect(after.id).toBe(before.id)
    expect((after.revision as Row).parent).toBe((before.revision as Row).id)
})

test('a kill during the picker’s write: the reload is bound to the emptied file, and Save fills it', async ({
    context,
}) => {
    const a = await context.newPage()
    await start(a)
    await edit(a, 1)
    await pauseAt(a, 'beforeClose')
    await queuePicks(a, ['coconut.nxsp'])
    await pressSave(a)
    await submitSave(a, 'coconut')
    await reached(a, 'beforeClose')
    expect(await readFile(a, 'coconut.nxsp')).toEqual([])
    await kill(a)

    const next = await visitAgain(context)
    await expect.poll(async () => (await sessionOf(next)).file?.name).toBe('coconut.nxsp')
    await pressSave(next)
    await expect(notice(next).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    await noDialog(next)
    expect((await readFile(next, 'coconut.nxsp'))!.length).toBeGreaterThan(0)
})

test('a kill after the picker’s close(): the next Save records the binding silently and adds no row, then writes in place', async ({
    context,
}) => {
    const a = await context.newPage()
    await start(a)
    await edit(a, 1)
    await pauseAt(a, 'closed')
    await queuePicks(a, ['coconut.nxsp'])
    await pressSave(a)
    await submitSave(a, 'coconut')
    await reached(a, 'closed')
    const written = await projectOf(a, 'coconut.nxsp')
    await kill(a)

    const next = await visitAgain(context)
    await expect.poll(async () => (await sessionOf(next)).file?.name).toBe('coconut.nxsp')
    // Unchanged: our own completed Save is recorded, and nothing more is written.
    await pressSave(next)
    await expect(
        notice(next).filter({ hasText: 'No changes since coconut.nxsp was saved' }),
    ).toBeVisible()
    await noDialog(next)
    const chain = await chainOf(next)
    expect(chain.revision).toMatchObject({ id: (written.revision as Row).id })
    const { entries } = await rows(next, ['entries'])
    // The recognised Save has no row: its state is the one before it.
    expect(
        entries!
            .map((row) => row.value)
            .filter((row) => row.revisionId === (written.revision as Row).id),
    ).toEqual([])
    // The handle stays the binding's: the next Save writes the file in place.
    await edit(next, 2)
    await pressSave(next)
    await expect(notice(next).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    expect(((await projectOf(next, 'coconut.nxsp')).revision as Row).parent).toBe(
        (written.revision as Row).id,
    )
    expect(await pickerCalls(next)).toHaveLength(1)
})

test('a kill after the picker’s close(): the next Save As… says once that earlier steps may not be included', async ({
    context,
}) => {
    const a = await context.newPage()
    await start(a)
    await edit(a, 1)
    await pauseAt(a, 'closed')
    await queuePicks(a, ['coconut.nxsp'])
    await pressSave(a)
    await submitSave(a, 'coconut')
    await reached(a, 'closed')
    await kill(a)

    const next = await visitAgain(context)
    await expect.poll(async () => (await sessionOf(next)).file?.name).toBe('coconut.nxsp')
    // The Save records the binding and adds no row; the cut still counts the row it lacks.
    await pressSave(next)
    await expect(
        notice(next).filter({ hasText: 'No changes since coconut.nxsp was saved' }),
    ).toBeVisible()
    const saveAs = async (beat: number, name?: string) => {
        await edit(next, beat)
        await next.evaluate(async () => {
            const { commands } = await import('/src/editor/commands/index.ts')
            const { runCommand } = await import('/src/editor/commands/runCommand.ts')
            void runCommand(commands.saveAs, 'button')
        })
        await submitSave(next, name, 'Save As')
    }
    await saveAs(2)
    await expect(
        notice(next).filter({
            hasText: 'Saved to coconut (2).nxsp. Some earlier Timeline steps may not be included.',
        }),
    ).toBeVisible()
    // Once: the file it wrote holds its own row, so the next Save As… carries it.
    await saveAs(3, 'melt')
    await expect(notice(next).filter({ hasText: 'Saved to melt.nxsp' })).toBeVisible()
    await expect(notice(next).filter({ hasText: 'Some earlier Timeline steps' })).toHaveCount(0)
})

test('two pickers on one unknown file: the last to take nse-bind owns it, and the other loses it', async ({
    context,
}) => {
    const a = await context.newPage()
    await start(a)
    await edit(a, 5)
    const b = await context.newPage()
    await start(b)
    await edit(b, 6)

    // A's pick waits before nse-bind while B picks, writes and binds.
    await pauseAt(a, 'picked')
    await queuePicks(a, ['coconut.nxsp'])
    await pressSave(a)
    await submitSave(a, 'coconut')
    await reached(a, 'picked')
    await unpause(a)
    await queuePicks(b, ['coconut.nxsp'])
    await pressSave(b)
    await submitSave(b, 'coconut')
    await expect(notice(b).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    const bChain = await chainOf(b)

    await release(a)
    await expect(notice(a).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    await noDialog(a)
    const aChain = await chainOf(a)
    expect((await projectOf(a, 'coconut.nxsp')).id).toBe(aChain.docId)
    const lost = (await chainById(a, bChain.chainId))!
    expect(lost.file).toBeUndefined()
    expect(lost.edited).toBe(true)
    // Both states are in storage.
    const { entries } = await rows(a, ['entries'])
    const sessions = new Set(entries!.map((row) => row.value.sessionId))
    expect(sessions).toContain(aChain.head)
    expect(sessions).toContain(bChain.head)
    await b.bringToFront()
    await expect.poll(async () => (await sessionOf(b)).file).toBeUndefined()
})

test('the file replaced between the write and the read-back leaves the binding as it was', async ({
    page,
}) => {
    await start(page)
    await savedTo(page, 'coconut.nxsp')
    const bound = (await chainOf(page)).file as Row
    await edit(page, 2)
    await pauseAt(page, 'readBack')
    await pressSave(page)
    await reached(page, 'readBack')
    const other = [1, 2, 3, 4, 5]
    await writeFile(page, 'coconut.nxsp', other)
    await release(page)
    await expect(page.getByRole('dialog')).toContainText('changed while it was being written')
    expect(((await chainOf(page)).file as Row).disk).toEqual(bound.disk)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await pressSave(page)
    await expect(saveDialog(page, '“coconut.nxsp” Changed')).toBeVisible()
    expect(await readFile(page, 'coconut.nxsp')).toEqual(other)
})

test('a frozen clock across two sessions: each its own start, and a write-back holds every row once', async ({
    context,
}) => {
    // The page's clock held far below the times storage has seen.
    await context.addInitScript(() => {
        Date.now = () => 1_000_000
    })
    const a = await context.newPage()
    await start(a)
    await savedTo(a, 'coconut.nxsp')
    await edit(a, 2)
    await a.evaluate(() => window.nseFlushTest!.flusher.flush({ strict: true }))
    const chainId = (await chainOf(a)).chainId
    await kill(a)

    const b = await visitAgain(context)
    await edit(b, 3)
    await pressSave(b)
    await expect.poll(async () => ((await projectOf(b, 'coconut.nxsp')).revision as Row).n).toBe(2)
    const { sessions, entries } = await rows(b, ['sessions', 'entries'])
    const own = sessions!.map((row) => row.value).filter((row) => row.chainId === chainId)
    expect(own).toHaveLength(2)
    expect(new Set(own.map((row) => row.startedAt)).size).toBe(2)
    const ids = new Set(own.map((row) => row.id))
    const stored = entries!.filter((row) => ids.has(row.value.sessionId))
    const history = (await projectOf(b, 'coconut.nxsp')).history as Row
    expect(history.entries).toBe(stored.length)
})
