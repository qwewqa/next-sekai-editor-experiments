import { expect, test, type Page } from '@playwright/test'
import { executePlan, planNxsp } from '../../src/local/nxsp'
import { fresh } from '../local/nxsp/chain'
import {
    chainOf,
    edit,
    notice,
    pressSave,
    projectOf,
    readFile,
    rows,
    start,
    submitSave,
    writeFile,
} from './saveFlows'

// The conflict dialog's choices (Part 1 §1.4.7, Part 0 §0.9.6): Replace keeps the version on disk
// as an ordinary session first, then writes with `replaces`; Save as a Separate File keeps the
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

test('Save as a Separate File keeps the docId and rebinds, leaving the changed file', async ({
    page,
}) => {
    await start(page)
    await savedOnce(page)
    const own = await chainOf(page)
    const dialog = await conflict(page)
    const other = await readFile(page, 'coconut.nxsp')
    await dialog.getByRole('button', { name: 'Save as a Separate File' }).click()
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

    const dialog = await conflict(page)
    await expect(dialog).toContainText('Changes are not being stored in this browser.')
    await expect(dialog.getByRole('button', { name: 'Replace' })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: 'Save as a Separate File' })).toBeFocused()
})
