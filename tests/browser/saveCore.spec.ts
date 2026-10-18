import { expect, test } from '@playwright/test'
import {
    chainOf,
    edit,
    notice,
    pickerCalls,
    pressSave,
    projectOf,
    rows,
    sessionOf,
    start,
    submitSave,
} from './saveFlows'

// Save and Save As on the Chromium override (Part 1 §1.4.7, §1.11.6's exit items): the first
// Save binds through the project picker, a second writes in place, revisions chain.

test('Save binds, the status shows the file name, and a second Save writes in place', async ({
    page,
}) => {
    await start(page)
    await edit(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()

    const calls = await pickerCalls(page)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
        picker: 'save',
        id: 'nse-project',
        suggestedName: 'coconut.nxsp',
        excludeAcceptAllOption: true,
        startIn: 'documents',
        types: [
            {
                description: 'Next SEKAI project file',
                accept: { 'application/octet-stream': ['.nxsp'] },
            },
        ],
    })
    await expect
        .poll(async () => (await chainOf(page)).file)
        .toMatchObject({
            name: 'coconut.nxsp',
            event: 'saved',
        })
    expect((await sessionOf(page)).file?.name).toBe('coconut.nxsp')
    const first = await projectOf(page, 'coconut.nxsp')
    const firstRevision = first.revision as Record<string, unknown>

    await edit(page, 2)
    await pressSave(page)
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    await expect
        .poll(async () => (await projectOf(page, 'coconut.nxsp')).revision)
        .toMatchObject({
            parent: firstRevision.id,
            ancestors: [firstRevision.id],
            n: 2,
        })
    expect(await pickerCalls(page)).toHaveLength(1)

    // Each Save's `save` entry, with its revision and device.
    const { entries } = await rows(page, ['entries'])
    const saves = entries!.map((row) => row.value).filter((row) => row.kind === 'save')
    expect(saves).toHaveLength(2)
    expect(saves[0]).toMatchObject({
        revisionId: firstRevision.id,
        device: { label: 'Web (Chrome)' },
    })
})
