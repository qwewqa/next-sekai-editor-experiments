import { expect, test, type Page } from '@playwright/test'
import { edit, notice, pressSave, saveDialog, sessionOf, start, submitSave } from './saveFlows'

// A tab left open across a deploy, or one without a connection, cannot load the Save code. The
// code loads in the background once startup is over; a press that finds it missing says so.

const FLOW = '**/src/editor/save/flow.ts*'
const failed = 'This could not be completed.'

const errors = new WeakMap<Page, string[]>()

test.beforeEach(({ page }) => {
    const seen: string[] = []
    errors.set(page, seen)
    page.on('pageerror', (error) => seen.push(error.message))
})

test.afterEach(({ page }) => {
    // A failed prefetch is silent.
    expect(errors.get(page)).toEqual([])
})

test('Save and Save As… say so when their code does not load, and change nothing', async ({
    page,
}) => {
    await page.route(FLOW, (route) => route.abort())
    await start(page)
    await edit(page, 1)
    const before = await sessionOf(page)

    await pressSave(page)
    await expect(notice(page).filter({ hasText: failed })).toBeVisible()
    await expect(saveDialog(page)).toHaveCount(0)
    expect(await sessionOf(page)).toEqual(before)

    await page.evaluate(async () => {
        const { saveAs } =
            (await import('/src/editor/commands/saveAs/index.ts')) as typeof import('../../src/editor/commands/saveAs')
        await saveAs.execute()
    })
    await expect(notice(page).filter({ hasText: failed })).toBeVisible()
    await expect(saveDialog(page, 'Save As')).toHaveCount(0)
    expect(await sessionOf(page)).toEqual(before)
})

test('Save works after its chunk becomes unavailable, having loaded once startup was over', async ({
    page,
}) => {
    const loaded = new Set<string>()
    page.on('response', (response) => {
        const match = /\/src\/(editor\/save\/flow|editor\/save\/exportPick)\.ts/.exec(
            response.url(),
        )
        if (match?.[1]) loaded.add(match[1])
    })
    await start(page)
    // No edit yet: the first edit loads the code too, so this is the prefetch alone.
    await expect.poll(() => loaded.size, { timeout: 20_000 }).toBe(2)
    await page.route('**/src/editor/save/**', (route) => route.abort())
    await edit(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
})
