import { expect, test } from '@playwright/test'
import { crafted, jsonOf, setJson } from '../local/nxsp/craft'
import {
    chainOf,
    edit,
    flushed,
    notice,
    pressSave,
    projectOf,
    queuePicks,
    readFile,
    rows,
    start,
    submitSave,
    writeFile,
} from './saveFlows'

for (const where of ['entity', 'data', 'value and ref'])
    test(`unknown ${where} content opens unbound and cannot replace its original`, async ({
        page,
    }) => {
        await start(page)
        const file = await crafted((items) => {
            const level = jsonOf(items, 'level.json')
            const entity = level.entities.find(
                (e: { archetype: string }) => e.archetype === 'Initialization',
            )
            const data = entity.data.find((d: { name: string }) => d.name === 'initialLife')
            if (where === 'entity') entity.futureContent = { important: 42 }
            else if (where === 'data') data.futureContent = { important: 43 }
            else data.ref = 'unused'
            setJson(items, 'level.json', level)
        })
        const bytes = [...new Uint8Array(await file.arrayBuffer())]
        await writeFile(page, 'coconut.nxsp', bytes)
        await queuePicks(page, ['coconut.nxsp'])
        await page.keyboard.press('o')
        await expect(notice(page).filter({ hasText: 'Made by a newer version' })).toBeVisible()
        const chain = await chainOf(page)
        expect(chain.file).toBeUndefined()
        expect(chain.revision).toBeUndefined()
        expect(chain.docId).not.toBe('doc')
        await edit(page, 3)
        await queuePicks(page, ['coconut.nxsp'])
        await pressSave(page)
        await submitSave(page)
        await expect(page.getByRole('dialog')).toContainText(
            'Not saved. "coconut.nxsp" could not be read completely.',
        )
        expect(await readFile(page, 'coconut.nxsp')).toEqual(bytes)
    })

test('a newer patch alone opens bound with its history, says so once, and saving writes this build’s patch', async ({
    page,
}) => {
    await start(page)
    const file = await crafted((items) => {
        setJson(items, 'project.json', { ...jsonOf(items, 'project.json'), patch: 3 })
    })
    await writeFile(page, 'coconut.nxsp', [...new Uint8Array(await file.arrayBuffer())])
    await queuePicks(page, ['coconut.nxsp'])
    await page.keyboard.press('o')
    const line = notice(page).filter({
        hasText: 'Made by a newer version of Next SEKAI Editor. Some content may not be shown.',
    })
    await expect(line).toHaveCount(1)
    // Bound to its file, as a whole open is, and its History kept (the file's own chronology).
    const chain = await chainOf(page)
    expect(chain.file).toBeDefined()
    expect(chain.revision).toBeDefined()
    expect(chain.docId).toBe('doc')
    await flushed(page)
    const { entries } = await rows(page, ['entries'])
    expect(entries!.length).toBeGreaterThan(1)
    // The open's line is the only one: not a partial open's "Saving makes a separate file".
    await expect(notice(page).filter({ hasText: 'Saving makes a separate file' })).toHaveCount(0)
    // Saving writes the file again, with the patch this build writes.
    await edit(page, 3)
    await pressSave(page)
    await expect.poll(async () => (await projectOf(page, 'coconut.nxsp')).patch).toBe(0)
    expect((await projectOf(page, 'coconut.nxsp')).minor).toBe(1)
})

test('a newer patch beside another unknown thing is one line, the partial open’s', async ({
    page,
}) => {
    await start(page)
    const file = await crafted((items) => {
        setJson(items, 'project.json', { ...jsonOf(items, 'project.json'), patch: 3 })
        items.push({ name: 'video/a.mp4', data: new TextEncoder().encode('x'), method: 'store' })
    })
    await writeFile(page, 'coconut.nxsp', [...new Uint8Array(await file.arrayBuffer())])
    await queuePicks(page, ['coconut.nxsp'])
    await page.keyboard.press('o')
    await expect(notice(page).filter({ hasText: 'Made by a newer version' })).toHaveCount(1)
    await expect(notice(page).filter({ hasText: 'Saving makes a separate file' })).toBeVisible()
    const chain = await chainOf(page)
    expect(chain.file).toBeUndefined()
})
