import { expect, test } from '@playwright/test'
import { crafted, jsonOf, setJson } from '../local/nxsp/craft'
import {
    chainOf,
    edit,
    notice,
    pressSave,
    queuePicks,
    readFile,
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
            'Not saved. "coconut.nxsp" could not be kept.',
        )
        expect(await readFile(page, 'coconut.nxsp')).toEqual(bytes)
    })
