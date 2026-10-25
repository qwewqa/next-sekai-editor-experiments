import { expect, test, type Page } from '@playwright/test'
import { executePlan, planNxsp } from '../../src/local/nxsp'
import { fresh } from '../local/nxsp/chain'
import {
    errorsFail,
    flush,
    holdWorker,
    load,
    noErrors,
    notice,
    openHistory,
    placeTap,
    release,
    reloadAndWait,
    timeline,
} from './historyJourney'
import {
    edit,
    pressSave,
    projectOf,
    readFile,
    rows,
    sessionOf,
    submitSave,
    writeFile,
} from './saveFlows'
import { skipWhereTheEditorCannotStart } from './webkitSupport'

// History's rows: a save from another device names it, and a row waiting to
// be stored already carries its note delta. A file records the device of its document's lineage,
// so this browser's saves stay its own across Save As… and a reopened copy, and two
// documents it saved can't be linked to it.

skipWhereTheEditorCannotStart()

test.afterEach(({ page }) => noErrors(page))

const opfs = { fileSystemAccess: 'opfs' } as const

const webDevice = /^Saved in the web editor \((Chrome|Edge|Firefox|Safari)\)$/

/** The rows' titles with their note deltas, top down. */
const titlesAndDeltas = (page: Page) =>
    timeline(page)
        .locator('[data-history-row]')
        .evaluateAll((rows) =>
            rows
                .map((row) => ({ row, top: parseFloat((row as HTMLElement).style.top) }))
                .sort((a, b) => a.top - b.top)
                .map(({ row }) => ({
                    title: row.querySelector('[data-history-group-action]')?.textContent?.trim(),
                    delta: row.querySelector('.timeline-count')?.textContent?.trim(),
                })),
        )

test('a save made on another device names it; this browser’s own does not', async ({ page }) => {
    test.slow()
    errorsFail(page)
    await load(page, { platform: opfs })
    await placeTap(page, { lane: -3, beat: 4 })
    await pressSave(page)
    await submitSave(page, 'device')
    await expect(notice(page, 'Saved to device.nxsp')).toBeVisible()
    await flush(page)
    await openHistory(page)
    await expect(timeline(page).getByText('Saved device.nxsp', { exact: true })).toBeVisible()

    // The same history, opened by another browser: the entry's device is no longer this one's.
    await page.evaluate(() =>
        localStorage.setItem(
            'sonolus-next-sekai-editor.deviceId',
            JSON.stringify('another-device'),
        ),
    )
    await reloadAndWait(page)
    await openHistory(page)
    await expect(timeline(page).getByText(webDevice)).toBeVisible()
    await expect(timeline(page).getByText('Saved device.nxsp', { exact: true })).toHaveCount(0)
})

const deviceOf = (project: Record<string, unknown>) =>
    ((project.revision as Record<string, unknown>).device as Record<string, unknown>).id

/** Opens an OPFS file with its handle, as Open File… does, and waits for its import. */
const openFile = async (page: Page, name: string) => {
    await page.evaluate(async (name) => {
        const root = await navigator.storage.getDirectory()
        const handle = await root.getFileHandle(name)
        const { openProject } = await import('/src/editor/commands/open/project.ts')
        await openProject(await handle.getFile(), handle)
    }, name)
    await expect.poll(async () => (await sessionOf(page)).file?.name).toBe(name)
    await expect
        .poll(async () => {
            const { sessions } = await rows(page, ['sessions'])
            return sessions!.filter((row) => row.value.importPending === true).length
        })
        .toBe(0)
}

/** The Timeline's rows for `names`' saves read as this browser's: no device named. */
const ownSaves = async (page: Page, names: string[]) => {
    await flush(page)
    await openHistory(page)
    for (const name of names)
        await expect(timeline(page).getByText(`Saved ${name}`, { exact: true })).toBeVisible()
    await expect(timeline(page).getByText(webDevice)).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(timeline(page)).toBeHidden()
}

test('this browser’s saves stay its own after Save As… and reopening; two documents differ', async ({
    page,
}) => {
    test.slow()
    errorsFail(page)
    await load(page, { platform: opfs })
    await placeTap(page, { lane: -3, beat: 4 })
    await pressSave(page)
    await submitSave(page, 'first')
    await expect(notice(page, 'Saved to first.nxsp')).toBeVisible()
    await page.evaluate(async () => {
        const { commands } = await import('/src/editor/commands/index.ts')
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        void runCommand(commands.saveAs, 'button')
    })
    await submitSave(page, 'second', 'Save As')
    await expect(notice(page, 'Saved to second.nxsp')).toBeVisible()
    // Save As… gives a new document id and keeps the lineage, and with it the device.
    const first = await projectOf(page, 'first.nxsp')
    const second = await projectOf(page, 'second.nxsp')
    expect(second.id).not.toBe(first.id)
    expect(deviceOf(second)).toBe(deviceOf(first))
    await ownSaves(page, ['first.nxsp', 'second.nxsp'])

    // A copy of the file opened again is a new chain, with the rows the file brought.
    await writeFile(page, 'copy.nxsp', (await readFile(page, 'second.nxsp'))!)
    await openFile(page, 'copy.nxsp')
    await ownSaves(page, ['first.nxsp', 'second.nxsp'])

    // Another document, which another browser saved: its save names that browser. Saved here,
    // it records another device id than the first document's.
    const other = await executePlan(planNxsp(fresh().input).plan, new Map())
    await writeFile(page, 'other.nxsp', new Uint8Array(await other.arrayBuffer()))
    await openFile(page, 'other.nxsp')
    await edit(page, 6)
    await pressSave(page)
    await expect(notice(page, 'Saved to other.nxsp')).toBeVisible()
    const saved = await projectOf(page, 'other.nxsp')
    expect(deviceOf(saved)).not.toBe(deviceOf(first))
    await flush(page)
    await openHistory(page)
    await expect(timeline(page).getByText('Saved other.nxsp', { exact: true })).toBeVisible()
    await expect(timeline(page).getByText(webDevice)).toHaveCount(1)
})

test('an undo and a redo waiting to be stored show their note delta', async ({ page }) => {
    test.slow()
    errorsFail(page, { allow: [/A flush failed/] })
    await load(page)
    await placeTap(page, { lane: -3, beat: 4 })
    await placeTap(page, { lane: -1, beat: 5 })
    await flush(page)
    const hold = await holdWorker(page, 'flush')
    try {
        await page.locator('canvas.editor-chart').focus()
        await page.keyboard.press('z')
        await hold.reached()
        await openHistory(page)
        await expect
            .poll(async () =>
                (await titlesAndDeltas(page)).find((row) => /^Undo/.test(row.title ?? '')),
            )
            .toMatchObject({ delta: '−1' })
        await page.locator('canvas.editor-chart').focus()
        await page.keyboard.press('y')
        await expect
            .poll(async () =>
                (await titlesAndDeltas(page)).find((row) => /^Redo/.test(row.title ?? '')),
            )
            .toMatchObject({ delta: '+1' })
    } finally {
        await release(page)
    }
})
