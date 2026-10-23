import { expect, test, type Page } from '@playwright/test'
import { executePlan, planNxsp, readNxsp } from '../../src/local/nxsp'
import { inspectNxsp } from '../../src/local/nxsp/inspect'
import { distinctRootChunks } from '../../src/local/nxsp/manifest'
import { fresh } from '../local/nxsp/chain'
import { distinctFile } from '../local/open/files'
import {
    chainOf,
    edit,
    flushed,
    notice,
    pressSave,
    queuePicks,
    reached,
    readFile,
    rows,
    saveDialog,
    sessionOf,
    start,
    submitSave,
    writeFile,
} from './saveFlows'

// Check File and History… (Part 1 §1.4.21; step 11 design §3.3, §5): the page side. A bound file
// is read in full and the history stored in this browser checked; damage in the file unlinks the
// session and leaves the file as it was; Cancel and a changed file write nothing; a download
// binding checks the stored history only.

type Row = Record<string, unknown>

const freshBytes = async () =>
    new Uint8Array(await (await executePlan(planNxsp(fresh().input).plan, new Map())).arrayBuffer())

/** A file whose first state has chunks of its own, outside its head. */
const distinctBytes = async () => new Uint8Array(await (await distinctFile()).file.arrayBuffer())

/** The file with a byte flipped in a chunk that neither its head nor any header uses. */
const withBadChunk = async (bytes: Uint8Array) => {
    const file = new File([bytes], 'coconut.nxsp')
    const read = await readNxsp(file)
    if (read.kind !== 'nxsp' || !read.history || !read.project?.history)
        throw new Error('A file with history is needed')
    const { history } = read
    const used = new Set(distinctRootChunks(history, [history.head]))
    for (const root of history.roots.values()) used.add(root[1] as string)
    const hash = [...history.index.keys()].find((each) => !used.has(each))
    if (!hash) throw new Error('A chunk outside the head is needed')
    const place = history.index.get(hash)!
    const source = await inspectNxsp(file, { token: 't', role: 'target', fingerprint: '' })
    const entry = source.entries.find((each) => each.name === read.project?.history?.chunks)
    if (!entry || entry.method !== 0) throw new Error('Stored chunks are needed')
    const damaged = new Uint8Array(bytes)
    const at = entry.dataOffset + place.offset + Math.floor(place.length / 2)
    damaged[at] = (damaged[at] ?? 0) ^ 0xff
    return damaged
}

const open = async (page: Page, name: string) => {
    await queuePicks(page, [name])
    await page.keyboard.press('o')
    await expect(notice(page).filter({ hasText: name }).first()).toBeVisible()
}

const imported = (page: Page) =>
    expect
        .poll(async () => {
            const { sessions } = await rows(page, ['sessions'])
            return sessions!.filter((row) => row.value.importPending === true).length
        })
        .toBe(0)

/** The chain opened from `bytes` as coconut.nxsp, its import done. */
const opened = async (page: Page, bytes: Uint8Array) => {
    await writeFile(page, 'coconut.nxsp', bytes)
    await open(page, 'coconut.nxsp')
    await imported(page)
}

/** Slows each batch of the check, and logs the points a run reaches (nothing pauses). */
const slowCheck = (page: Page, ms: number) =>
    page.evaluate((ms) => {
        localStorage.setItem('nse.test.checkDelay', String(ms))
        localStorage.setItem('nse.test.savePause', 'never')
    }, ms)

const runCheck = (page: Page) =>
    page.evaluate(async () => {
        const { commands } = await import('/src/editor/commands/index.ts')
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        void runCommand(commands.checkProject)
    })

const checkDialog = (page: Page) =>
    page.getByRole('dialog').filter({ hasText: 'Check File and History' })

const label = (page: Page) => page.locator('[data-status-text]')

/** Every stored row of these stores, for comparing before and after a run that writes nothing. */
const stored = async (page: Page) => {
    await flushed(page)
    const all = await rows(page, ['entries', 'chains', 'nodes', 'chunks', 'media'])
    return JSON.stringify(
        Object.entries(all).map(([store, list]) => [
            store,
            list.map((row) => [row.key, row.value]),
        ]),
    )
}

/** A byte of a chunk only this row's state needs goes bad (the worker's test hook). */
const damageRow = async (page: Page) => {
    await flushed(page)
    const { sessionId } = await sessionOf(page)
    const { entries } = await rows(page, ['entries'])
    const own = entries!
        .map((row) => row.value)
        .filter((row) => row.sessionId === sessionId)
        .sort((a, b) => (a.seq as number) - (b.seq as number))
    for (const row of own) {
        const hash = await page.evaluate(
            (key) => window.nseStorageTest!.worker.call('testDamage', key) as Promise<string>,
            { sessionId: row.sessionId as string, seq: row.seq as number },
        )
        if (hash) return hash
    }
    throw new Error('No row has a chunk of its own')
}

const keptFalse = async (page: Page) => {
    const { entries } = await rows(page, ['entries'])
    return entries!.filter((row) => row.value.kept === false).length
}

test('a clean bound file: no damage found, the file and the stored history checked', async ({
    page,
}) => {
    await start(page)
    await opened(page, await freshBytes())
    const before = await readFile(page, 'coconut.nxsp')
    await runCheck(page)
    const dialog = checkDialog(page)
    await expect(dialog).toContainText('No damage found.')
    await expect(dialog).toContainText(
        'Checked "coconut.nxsp" and the history stored in this browser.',
    )
    await expect(dialog).not.toContainText('could not be read')
    expect(await readFile(page, 'coconut.nxsp')).toEqual(before)
    await expect(label(page)).not.toContainText(/separate copy/i)
    expect((await chainOf(page)).file).toBeDefined()
})

test('a chunk damaged in the file after it was opened: damaged, unlinked, the file untouched', async ({
    page,
}) => {
    await start(page)
    const good = await distinctBytes()
    await opened(page, good)
    // Damaged on disk after the open: storage holds the chunk intact, so only a full read finds it.
    await writeFile(page, 'coconut.nxsp', await withBadChunk(good))
    const before = await readFile(page, 'coconut.nxsp')
    await runCheck(page)
    const dialog = checkDialog(page)
    await expect(dialog).toContainText('"coconut.nxsp" is damaged. Saving makes a separate file.')
    await expect(dialog).toContainText(
        'Checked "coconut.nxsp" and the history stored in this browser.',
    )
    await expect(dialog).not.toContainText('No damage found.')
    await expect(label(page)).toContainText(/separate copy of coconut.nxsp/i)
    expect((await chainOf(page)).file).toBeUndefined()
    expect(await keptFalse(page)).toBe(0)
    // The next Save asks for a new file; the damaged one is not written.
    await dialog.getByRole('button', { name: 'OK' }).click()
    await pressSave(page)
    await expect(saveDialog(page)).toBeVisible()
    expect(await readFile(page, 'coconut.nxsp')).toEqual(before)
})

test('with the open’s import still running: the check waits for it, then finds no damage', async ({
    page,
}) => {
    await start(page)
    await writeFile(page, 'coconut.nxsp', await freshBytes())
    await page.evaluate(() => {
        localStorage.setItem('nse.test.importDelay', '700')
    })
    await open(page, 'coconut.nxsp')
    await runCheck(page)
    const dialog = checkDialog(page)
    await expect(dialog).toContainText('Checking coconut.nxsp')
    await expect(dialog).toContainText('No damage found.', { timeout: 20_000 })
    // It did not finish before the import: every row was imported when the report came.
    const { sessions } = await rows(page, ['sessions'])
    expect(sessions!.filter((row) => row.value.importPending === true)).toHaveLength(0)
    expect(await keptFalse(page)).toBe(0)
})

test('Cancel mid-check writes nothing, then the run ends', async ({ page }) => {
    await start(page)
    const good = await distinctBytes()
    await opened(page, good)
    await writeFile(page, 'coconut.nxsp', await withBadChunk(good))
    const before = await readFile(page, 'coconut.nxsp')
    const rowsBefore = await stored(page)
    await slowCheck(page, 800)
    await runCheck(page)
    const progress = checkDialog(page)
    await expect(progress).toContainText('Checking')
    await progress.getByRole('button', { name: 'Close' }).click()
    await reached(page, 'checkEnd')
    await expect(checkDialog(page)).toHaveCount(0)
    // The damage was not acted on: still bound, nothing marked, nothing written.
    await expect(label(page)).not.toContainText(/separate copy/i)
    expect((await chainOf(page)).file).toBeDefined()
    expect(await stored(page)).toBe(rowsBefore)
    expect(await readFile(page, 'coconut.nxsp')).toEqual(before)
})

test('the file rewritten mid-check: it changed, and nothing is written', async ({ page }) => {
    await start(page)
    const good = await freshBytes()
    await opened(page, good)
    await damageRow(page)
    const rowsBefore = await stored(page)
    await slowCheck(page, 1200)
    await runCheck(page)
    const dialog = checkDialog(page)
    // The file phase is over; the finish has not started.
    await expect(dialog).toContainText('Checking stored history')
    const other = await distinctBytes()
    await writeFile(page, 'coconut.nxsp', other)
    await expect(dialog).toContainText('"coconut.nxsp" changed while it was being checked.', {
        timeout: 20_000,
    })
    await reached(page, 'checkEnd')
    expect(await readFile(page, 'coconut.nxsp')).toEqual([...other])
    await expect(label(page)).not.toContainText(/separate copy/i)
    expect((await chainOf(page)).file).toBeDefined()
    expect(await stored(page)).toBe(rowsBefore)
    expect(await keptFalse(page)).toBe(0)
})

test('stored damage the file can repair is repaired, and no step is marked', async ({ page }) => {
    await start(page)
    await opened(page, await freshBytes())
    await damageRow(page)
    await runCheck(page)
    const dialog = checkDialog(page)
    await expect(dialog).toContainText(/Repaired \d+ Timeline steps?\./)
    await expect(dialog).not.toContainText('is damaged')
    expect(await keptFalse(page)).toBe(0)
    // Checked again, nothing is left.
    await dialog.getByRole('button', { name: 'OK' }).click()
    await runCheck(page)
    await expect(checkDialog(page)).toContainText('No damage found.')
})

test('a download binding: only the history stored in this browser is checked', async ({ page }) => {
    await start(page, { fileSystemAccess: false })
    await edit(page, 1)
    await edit(page, 2)
    await flushed(page)
    await pressSave(page)
    const downloading = page.waitForEvent('download')
    await submitSave(page, 'coconut')
    await downloading
    await runCheck(page)
    const dialog = checkDialog(page)
    await expect(dialog).toContainText('No damage found.')
    await expect(dialog).toContainText('Checked the history stored in this browser.')
    await expect(dialog).not.toContainText('coconut.nxsp')
})

test('stored damage with no file to repair it from: the steps are marked', async ({ page }) => {
    await start(page, { fileSystemAccess: false })
    await edit(page, 1)
    await edit(page, 2)
    await damageRow(page)
    await runCheck(page)
    await expect(checkDialog(page)).toContainText(
        /Timeline steps? stored in this browser (is|are) damaged\./,
    )
    expect(await keptFalse(page)).toBeGreaterThan(0)
})

test('a Save pressed during a check waits for it', async ({ page }) => {
    await start(page)
    await edit(page, 1)
    await slowCheck(page, 800)
    await runCheck(page)
    await expect(checkDialog(page)).toContainText('Checking')
    await page.evaluate(async () => {
        const { commands } = await import('/src/editor/commands/index.ts')
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        void runCommand(commands.save)
    })
    await expect(saveDialog(page)).toBeVisible()
    // One queue: the Save's dialog came after the check's end, never beside its run.
    expect(await page.evaluate(() => window.nseSaveTest?.reached ?? [])).toContain('checkEnd')
})

test('a session switch cancels the check', async ({ page }) => {
    await start(page)
    const good = await distinctBytes()
    await opened(page, good)
    await writeFile(page, 'coconut.nxsp', await withBadChunk(good))
    const { chainId } = await chainOf(page)
    await slowCheck(page, 800)
    await runCheck(page)
    await expect(checkDialog(page)).toContainText('Checking')
    await page.evaluate(async () => {
        const { resetState } = await import('/src/history/index.ts')
        resetState(false)
    })
    await reached(page, 'checkEnd')
    await expect(checkDialog(page)).toHaveCount(0)
    // The old chain's file was not unlinked by a check that no longer owned its session.
    const { chains } = await rows(page, ['chains'])
    const old = chains!.map((row) => row.value).find((row) => row.chainId === chainId)
    expect(old?.file).toBeDefined()
})
