import { expect, test, type Page } from '@playwright/test'
import { executePlan, planNxsp } from '../../src/local/nxsp'
import { fresh } from '../local/nxsp/chain'
import { crafted, jsonOf, setJson } from '../local/nxsp/craft'
import { closePage, waitForStartup } from './editorFixture'
import {
    chainOf,
    edit,
    editPastUndo,
    notice,
    pauseAt,
    pressSave,
    projectOf,
    prompts,
    queuePicks,
    reached,
    readFile,
    release,
    removeFile,
    rows,
    saveDialog,
    sessionOf,
    start,
    submitSave,
    thinUndone,
    writeFile,
} from './saveFlows'

// The conflict dialog's choices: Replace keeps the version on disk
// as an ordinary session first, then writes with `replaces`; Save as a Separate File… keeps the
// `docId` in a new file; nothing is ever written over a changed file unseen.

type Row = Record<string, unknown>

const otherBytes = async () => [
    ...new Uint8Array(
        await (await executePlan(planNxsp(fresh().input).plan, new Map())).arrayBuffer(),
    ),
]

const savedOnce = async (page: Page) => {
    await edit(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    await expect.poll(async () => (await chainOf(page)).file).toMatchObject({ event: 'saved' })
}

const conflict = async (page: Page) => {
    await writeFile(page, 'coconut.nxsp', await otherBytes())
    await edit(page, 2)
    await pressSave(page)
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('"coconut.nxsp" Changed')
    // Past the dialog's activation guard.
    await page.waitForTimeout(350)
    return dialog
}

test('Replace keeps the version on disk as a session first, then writes with replaces', async ({
    page,
}) => {
    await start(page)
    await savedOnce(page)
    const own = await chainOf(page)
    const dialog = await conflict(page)
    await expect(dialog).toContainText('A different project file, "Coconut (Master)".')
    await dialog.getByRole('button', { name: 'Replace' }).click()
    await expect
        .poll(async () => ((await projectOf(page, 'coconut.nxsp')).revision as Row).replaces, {
            timeout: 15_000,
        })
        .toBe('r001-0000-4000-8000-000000000000')

    const written = await projectOf(page, 'coconut.nxsp')
    const revision = written.revision as Record<string, unknown>
    expect(revision.replaces).toBe('r001-0000-4000-8000-000000000000')
    expect(written.id).toBe(own.docId)
    // The version on disk is an ordinary session of its own, unbound, with its history.
    const { chains, sessions } = await rows(page, ['chains', 'sessions'])
    const kept = chains!.map((row) => row.value).find((chain) => chain.docId === 'doc')!
    expect(kept.name).toMatch(/^coconut \(replaced .+\)$/)
    expect(kept.file).toBeUndefined()
    const session = sessions!.map((row) => row.value).find((row) => row.chainId === kept.chainId)!
    expect(session.origin).toBe('replaced')
    expect(session.importPending).toBeUndefined()
})

test('Save as a Separate File… keeps the docId and rebinds, leaving the changed file', async ({
    page,
}) => {
    await start(page)
    await savedOnce(page)
    const own = await chainOf(page)
    const dialog = await conflict(page)
    const other = await readFile(page, 'coconut.nxsp')
    await dialog.getByRole('button', { name: 'Save as a Separate File…' }).click()
    await expect(notice(page).filter({ hasText: /Saved to coconut \(Chrome, / })).toBeVisible()
    const chain = await chainOf(page)
    expect(chain.docId).toBe(own.docId)
    expect((chain.file as { name: string }).name).toMatch(/^coconut \(Chrome, .+\)\.nxsp$/)
    expect(await readFile(page, 'coconut.nxsp')).toEqual(other)
})

test('with storing paused, Save still writes and appends, and Replace writes nothing', async ({
    page,
}) => {
    await start(page, { storage: { forceQuota: true } })
    await edit(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    const first = await projectOf(page, 'coconut.nxsp')
    // The binding lives in memory: a second Save appends to the first's file.
    await edit(page, 2)
    await pressSave(page)
    await expect
        .poll(async () => ((await projectOf(page, 'coconut.nxsp')).revision as Row).parent)
        .toBe((first.revision as Row).id)
    // That Save has bound the file in memory: the next press is its own.
    const second = ((await projectOf(page, 'coconut.nxsp')).revision as Row).id
    await expect
        .poll(() =>
            page.evaluate(() => window.nseFlushTest?.flusher.session?.identity?.revision.id),
        )
        .toBe(second)

    const dialog = await conflict(page)
    await expect(dialog).toContainText('Changes are not being stored in this browser.')
    await expect(dialog.getByRole('button', { name: 'Replace' })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: 'Save as a Separate File…' })).toBeFocused()
})

test('Replace stores and commits the version on disk before it writes the file', async ({
    page,
}) => {
    await start(page)
    await savedOnce(page)
    const dialog = await conflict(page)
    const other = await readFile(page, 'coconut.nxsp')
    await pauseAt(page, 'kept')
    await dialog.getByRole('button', { name: 'Replace' }).click()
    await reached(page, 'kept')
    // Kept and committed, while the file is still the version on disk.
    const { chains } = await rows(page, ['chains'])
    expect(chains!.map((row) => row.value).some((chain) => chain.docId === 'doc')).toBe(true)
    expect(await readFile(page, 'coconut.nxsp')).toEqual(other)
    await release(page)
    await expect
        .poll(async () => ((await projectOf(page, 'coconut.nxsp')).revision as Row).replaces, {
            timeout: 15_000,
        })
        .toBe('r001-0000-4000-8000-000000000000')
})

test('a file changed again while Replace keeps it gives the dialog again, not a storage error', async ({
    page,
}) => {
    await start(page)
    await savedOnce(page)
    const dialog = await conflict(page)
    await writeFile(page, 'coconut.nxsp', [1, 2, 3])
    await dialog.getByRole('button', { name: 'Replace' }).click()
    await expect(page.getByRole('dialog')).toContainText('"coconut.nxsp" Changed')
    await expect(page.getByRole('dialog')).not.toContainText('not being stored')
    expect(await readFile(page, 'coconut.nxsp')).toEqual([1, 2, 3])
})

test('Open the Other Version opens the file on disk; this session keeps its changes', async ({
    page,
}) => {
    await start(page)
    await savedOnce(page)
    const own = await chainOf(page)
    const dialog = await conflict(page)
    await dialog.getByRole('button', { name: 'Open the Other Version' }).click()
    await expect.poll(async () => (await sessionOf(page)).docId).toBe('doc')
    await expect(notice(page).filter({ hasText: 'Reopen' })).toBeVisible()
    // The session left keeps its binding and its edit, in storage.
    const { chains } = await rows(page, ['chains'])
    const left = chains!.map((row) => row.value).find((chain) => chain.chainId === own.chainId)!
    expect((left.file as Row).name).toBe('coconut.nxsp')
    expect(left.edited).toBe(true)
})

test('Open the Other Version asks first when storing is paused, and Cancel keeps the chart', async ({
    page,
}) => {
    await start(page, { storage: { forceQuota: true } })
    await edit(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    const sessionId = () => page.evaluate(() => window.nseFlushTest?.flusher.session?.id)
    const own = await sessionId()
    const dialog = await conflict(page)
    await expect(dialog).toContainText('Changes are not being stored in this browser.')
    await dialog.getByRole('button', { name: 'Open the Other Version' }).click()
    const prompt = page.getByRole('dialog')
    await expect(prompt.getByRole('button', { name: 'Leave Anyway' })).toBeVisible()
    // Past the dialog's activation guard.
    await page.waitForTimeout(350)
    await prompt.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await sessionId()).toBe(own)
})

test('Open the Other Version, then Save in its prompt, gives the conflict dialog again and later Saves work', async ({
    page,
}) => {
    await start(page, { storage: { forceQuota: true } })
    await edit(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    const dialog = await conflict(page)
    await dialog.getByRole('button', { name: 'Open the Other Version' }).click()
    const prompt = page.getByRole('dialog')
    await expect(prompt.getByRole('button', { name: 'Leave Anyway' })).toBeVisible()
    // Past the dialog's activation guard.
    await page.waitForTimeout(350)
    await prompt.getByRole('button', { name: 'Save', exact: true }).click()
    // The prompt's Save runs after the Save that raised the first dialog has finished.
    await expect(page.getByRole('dialog')).toContainText('"coconut.nxsp" Changed')
    await page.waitForTimeout(350)
    await page.getByRole('button', { name: 'Save as a Separate File…' }).click()
    await expect(notice(page).filter({ hasText: /Saved to coconut \(Chrome, / })).toBeVisible()
})

test('Open the Other Version says when the file cannot be read', async ({ page }) => {
    await start(page)
    await savedOnce(page)
    const dialog = await conflict(page)
    await removeFile(page, 'coconut.nxsp')
    await dialog.getByRole('button', { name: 'Open the Other Version' }).click()
    await expect(
        notice(page).filter({ hasText: '"coconut.nxsp" could not be read.' }),
    ).toBeVisible()
})

test('the Replace guard: a file holding the base this browser lost rows of is never replaced', async ({
    context,
}) => {
    const page = await context.newPage()
    await start(page)
    await editPastUndo(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    // A later Save lands, and the tab dies before its binding and with no marker: the file is a
    // descendant that holds the base.
    const { chainId } = await chainOf(page)
    await edit(page, 10)
    await pauseAt(page, 'closed')
    await pressSave(page)
    await reached(page, 'closed')
    await page.evaluate((chainId) => {
        localStorage.removeItem('nse.test.savePause')
        localStorage.removeItem(`sonolus-next-sekai-editor.saving.${chainId}`)
    }, String(chainId))
    await closePage(page, { runBeforeUnload: false })

    const next = await context.newPage()
    await next.goto('/')
    await waitForStartup(next)
    expect(await thinUndone(next)).toBe(true)
    const disk = await readFile(next, 'coconut.nxsp')
    await edit(next, 11)
    await pressSave(next)
    const dialog = next.getByRole('dialog')
    await expect(dialog).toContainText('"coconut.nxsp" Changed')
    // A thinned root is a flag the chain can't show it holds: the uncertain reason. Rows gone from
    // the chain give the definite one (`replaceDecision` units).
    await expect(dialog).toContainText(
        'It may contain earlier Timeline steps that are no longer stored in this browser.',
    )
    await expect(dialog.getByRole('button', { name: 'Replace' })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: 'Save as a Separate File…' })).toBeFocused()
    expect(await readFile(next, 'coconut.nxsp')).toEqual(disk)
})

test('the Replace guard: a diverged file is kept first, and the write says what it lost', async ({
    page,
}) => {
    await start(page)
    await editPastUndo(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    expect(await thinUndone(page)).toBe(true)
    const dialog = await conflict(page)
    await expect(dialog.getByRole('button', { name: 'Replace' })).toBeEnabled()
    await dialog.getByRole('button', { name: 'Replace' }).click()
    await expect(
        notice(page).filter({
            hasText: 'Saved to coconut.nxsp. Some earlier Timeline steps were not kept.',
        }),
    ).toBeVisible({ timeout: 15_000 })
    const { chains } = await rows(page, ['chains'])
    expect(chains!.map((row) => row.value).some((chain) => chain.docId === 'doc')).toBe(true)
})

test('Replace is offered for a file on disk with a newer patch, and keeps it first as a session with its history', async ({
    page,
}) => {
    await start(page)
    await savedOnce(page)
    const file = await crafted((items) => {
        setJson(items, 'project.json', { ...jsonOf(items, 'project.json'), patch: 3 })
    })
    await writeFile(page, 'coconut.nxsp', [...new Uint8Array(await file.arrayBuffer())])
    await edit(page, 2)
    await pressSave(page)
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('"coconut.nxsp" Changed')
    await page.waitForTimeout(350)
    // A newer patch is not "Made by a newer version": nothing it holds is unread.
    await expect(dialog.getByRole('button', { name: 'Replace' })).toBeEnabled()
    await expect(dialog).not.toContainText('Made by a newer version')
    await dialog.getByRole('button', { name: 'Replace' }).click()
    await expect
        .poll(async () => ((await projectOf(page, 'coconut.nxsp')).revision as Row).replaces, {
            timeout: 15_000,
        })
        .toBe('r001-0000-4000-8000-000000000000')
    expect((await projectOf(page, 'coconut.nxsp')).patch).toBe(0)
    // The file that was on disk is kept, with its history, as a session of its own.
    const { chains, sessions } = await rows(page, ['chains', 'sessions'])
    const kept = chains!.map((row) => row.value).find((chain) => chain.docId === 'doc')!
    expect(kept.name).toMatch(/^coconut \(replaced .+\)$/)
    const session = sessions!.map((row) => row.value).find((row) => row.chainId === kept.chainId)!
    expect(session.origin).toBe('replaced')
})

/** Opens an OPFS file with its handle, as Open File… on a save picker's platform does. */
const openFile = (page: Page, name: string) =>
    page.evaluate(async (name) => {
        const root = await navigator.storage.getDirectory()
        const handle = await root.getFileHandle(name)
        const { openProject } = await import('/src/editor/commands/open/project.ts')
        await openProject(await handle.getFile(), handle)
    }, name)

for (const reload of [false, true])
    test(`a separate copy made by Open takes its file over when saved over it${reload ? ', after a reload' : ''}`, async ({
        context,
    }) => {
        const a = await context.newPage()
        await start(a)
        await savedOnce(a)
        const aChain = await chainOf(a)

        const b = await context.newPage()
        await start(b)
        await openFile(b, 'coconut.nxsp')
        await expect(
            notice(b).filter({
                hasText:
                    '"coconut.nxsp" is open in another tab or window, so this is a separate copy.',
            }),
        ).toBeVisible()
        expect((await sessionOf(b)).file).toBeUndefined()
        if (reload) {
            await b.reload()
            await waitForStartup(b)
            await expect(b.locator('canvas.editor-chart')).toBeVisible()
        }
        await edit(b, 7)
        await queuePicks(b, ['coconut.nxsp'])
        await pressSave(b)
        await submitSave(b)
        await expect(notice(b).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
        await expect(b.getByRole('dialog')).toHaveCount(0)
        const bChain = await chainOf(b)
        expect((bChain.file as Row).name).toBe('coconut.nxsp')
        expect(bChain.chainId).not.toBe(aChain.chainId)
        expect((await projectOf(b, 'coconut.nxsp')).id).toBe(bChain.docId)

        // A loses the file and its next Save asks where.
        await a.bringToFront()
        await expect.poll(async () => (await sessionOf(a)).file).toBeUndefined()
        expect(await prompts(a)).toBe(true)
        await edit(a, 9)
        await pressSave(a)
        await expect(saveDialog(a)).toContainText(
            '"coconut.nxsp" was replaced from another tab or window.',
        )
    })
