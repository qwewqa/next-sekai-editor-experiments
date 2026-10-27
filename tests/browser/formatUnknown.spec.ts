import { expect, test } from '@playwright/test'
import { crafted, jsonOf, setJson, type Loose } from '../local/nxsp/craft'
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
        await expect(
            notice(page).filter({ hasText: 'This file was created by a newer version' }),
        ).toBeVisible()
        const chain = await chainOf(page)
        expect(chain.file).toBeUndefined()
        expect(chain.revision).toBeUndefined()
        expect(chain.docId).not.toBe('doc')
        await edit(page, 3)
        await queuePicks(page, ['coconut.nxsp'])
        await pressSave(page)
        await submitSave(page)
        await expect(page.getByRole('dialog')).toContainText(
            'Not saved. “coconut.nxsp” could not be read in full.',
        )
        expect(await readFile(page, 'coconut.nxsp')).toEqual(bytes)
    })

test("a newer patch alone opens bound with its history, says so once, and saving writes this build's patch", async ({
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
        hasText:
            'This file was created by a newer version of Next SEKAI Editor. Some content may not be shown.',
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
    // The open's line is the only one: not a partial open's "Saving will create a separate file".
    await expect(
        notice(page).filter({ hasText: 'Saving will create a separate file' }),
    ).toHaveCount(0)
    // Saving writes the file again, with the patch this build writes.
    await edit(page, 3)
    await pressSave(page)
    await expect.poll(async () => (await projectOf(page, 'coconut.nxsp')).patch).toBe(0)
    expect((await projectOf(page, 'coconut.nxsp')).minor).toBe(0)
})

test("a newer patch beside another unknown thing is one line, the partial open's", async ({
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
    await expect(
        notice(page).filter({ hasText: 'This file was created by a newer version' }),
    ).toHaveCount(1)
    await expect(
        notice(page).filter({ hasText: 'Saving will create a separate file' }),
    ).toBeVisible()
    const chain = await chainOf(page)
    expect(chain.file).toBeUndefined()
})

test('a newer-patch file that holds newer content: a bound Save keeps what it carries and drops only what it ignores', async ({
    page,
}) => {
    await start(page)
    const x = { future: [1, { deep: true }] }
    const file = await crafted((items) => {
        // What a later build would add that this one can leave out: a derived `cache/` entry, a
        // top-level key (kept as `extra`), and an `x` on an entry, a step, the manifest and a slot.
        setJson(items, 'project.json', {
            ...jsonOf(items, 'project.json'),
            patch: 3,
            zzFutureSetting: { view: 'wide' },
        })
        const manifest = jsonOf(items, 'history/manifest.json')
        manifest.x = x
        manifest.undoStack.x = x
        manifest.undoStack.slots[0].x = x
        manifest.entries[1].x = x
        manifest.entries[1].step.x = x
        setJson(items, 'history/manifest.json', manifest)
        items.push({
            name: 'cache/waveform.bin',
            data: new TextEncoder().encode('derived'),
            method: 'store',
        })
    })
    await writeFile(page, 'coconut.nxsp', [...new Uint8Array(await file.arrayBuffer())])
    await queuePicks(page, ['coconut.nxsp'])
    await page.keyboard.press('o')
    // Whole: the line, no partial open's, bound.
    await expect(
        notice(page).filter({
            hasText:
                'This file was created by a newer version of Next SEKAI Editor. Some content may not be shown.',
        }),
    ).toHaveCount(1)
    expect((await chainOf(page)).file).toBeDefined()
    await flushed(page)
    await edit(page, 3)
    await pressSave(page)
    await expect.poll(async () => (await projectOf(page, 'coconut.nxsp')).patch).toBe(0)
    const written = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory()
        const { ZipReader } =
            (await import('/src/zip/reader.ts')) as typeof import('../../src/zip/reader')
        const reader = await ZipReader.open(
            await (await root.getFileHandle('coconut.nxsp')).getFile(),
        )
        const text = async (name: string) =>
            JSON.parse(
                new TextDecoder().decode(
                    await reader.read(reader.get(name)!, { maxSize: 4_000_000 }),
                ),
            ) as Loose
        return {
            names: reader.entries.map((entry) => entry.name),
            project: await text('project.json'),
            manifest: await text('history/manifest.json'),
        }
    })
    // Kept: the top-level key, and the entry and step `x` (carried by value).
    expect(written.project.zzFutureSetting).toEqual({ view: 'wide' })
    const carried = [...(written.manifest.entries as Loose[])].find(
        (entry) => entry.x !== undefined,
    )
    expect(carried?.x).toEqual(x)
    expect(carried?.step?.x).toEqual(x)
    // Dropped: the derived entry, and the manifest and undo stack `x`, which the writer rebuilds.
    expect(written.names).not.toContain('cache/waveform.bin')
    expect(written.manifest.x).toBeUndefined()
    expect(written.manifest.undoStack.x).toBeUndefined()
    expect(written.manifest.undoStack.slots[0].x).toBeUndefined()
})
